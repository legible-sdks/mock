import { type Entry, type Formats, type MaterializeContext, formFields } from './form.ts';
import { type Obj, child, isObj } from './spec.ts';
import type { Issue, Validator } from './validator.ts';

export interface MediaType {
  type: string;
  params: Record<string, string>;
}

export interface RequestBodySpec {
  required: boolean;
  content: Array<{ type: string; schema: unknown; ptr: string; encoding: Obj }>;
}

export interface BodyContext {
  doc: Obj;
  validator: Validator;
  form: Formats;
  strict: boolean;
}

export function parseMediaType(header: string | undefined): MediaType | null {
  if (!header) return null;
  const [head, ...rest] = header.split(';');
  const type = (head ?? '').trim().toLowerCase();
  if (!type) return null;
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params[part.slice(0, eq).trim().toLowerCase()] = value;
  }
  return { type, params };
}

export function mediaMatches(pattern: string, type: string): boolean {
  const p = pattern.split(';')[0]?.trim().toLowerCase() ?? '';
  if (p === type || p === '*/*' || p === '*') return true;
  const [pMain, pSub] = p.split('/');
  const [tMain, tSub] = type.split('/');
  if (pSub === '*' && pMain === tMain) return true;
  if (pMain === tMain && pSub?.startsWith('*+') && tSub?.endsWith(pSub.slice(1))) return true;
  return false;
}

export function isJsonType(type: string): boolean {
  return type === 'application/json' || /\+json$/.test(type) || type === 'text/json';
}

export function readRequestBody(raw: unknown, ptr: string): RequestBodySpec | null {
  if (!isObj(raw)) return null;
  const content: RequestBodySpec['content'] = [];
  if (isObj(raw.content)) {
    for (const [type, media] of Object.entries(raw.content as Obj)) {
      content.push({
        type,
        schema: isObj(media) ? media.schema : undefined,
        ptr: child(ptr, 'content', type, 'schema'),
        encoding: isObj(media) && isObj(media.encoding) ? media.encoding : {},
      });
    }
  }
  return { required: raw.required === true, content };
}

export function validateBody(ctx: BodyContext, spec: RequestBodySpec | null, header: string | undefined, body: Buffer, label: string): Issue[] {
  const media = parseMediaType(header);
  const empty = body.length === 0;
  if (!spec || spec.content.length === 0) {
    if (empty) return [];
    return [{ location: 'body', code: 'unexpected-body', message: `${label} takes no request body`, severity: ctx.strict ? 'error' : 'warning' }];
  }
  if (empty && !media) {
    if (spec.required) return [{ location: 'body', code: 'required', message: `${label} needs a request body`, severity: 'error' }];
    return [];
  }
  if (!media) {
    return [{ location: 'header.content-type', code: 'content-type', message: 'The request has a body but no Content-Type header', severity: 'error' }];
  }
  const target = spec.content.find((c) => c.type.split(';')[0]?.trim().toLowerCase() === media.type) ?? spec.content.find((c) => mediaMatches(c.type, media.type));
  if (!target) {
    return [
      {
        location: 'header.content-type',
        code: 'content-type',
        message: `Body Content-Type "${media.type}" is not one the operation declares (${spec.content.map((c) => c.type).join(', ')})`,
        severity: 'error',
      },
    ];
  }
  if (empty) {
    if (spec.required) return [{ location: 'body', code: 'required', message: `${label} needs a request body`, severity: 'error' }];
    return [];
  }
  let value: unknown;
  const issues: Issue[] = [];
  if (isJsonType(media.type)) {
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch (error) {
      return [{ location: 'body', code: 'json', message: `The request body is not valid JSON: ${(error as Error).message}`, severity: 'error' }];
    }
  } else if (media.type === 'application/x-www-form-urlencoded') {
    const pairs = [...new URLSearchParams(body.toString('utf8'))].map(([key, v]): Entry => ({ key, value: v, text: true }));
    value = fields(ctx, pairs, target.schema, ctx.form, issues);
  } else if (media.type === 'multipart/form-data') {
    const boundary = media.params.boundary;
    if (!boundary) return [{ location: 'header.content-type', code: 'content-type', message: 'multipart/form-data needs a boundary parameter', severity: 'error' }];
    const parts = parseMultipart(body, boundary);
    if (!parts) return [{ location: 'body', code: 'multipart', message: 'The multipart/form-data body is malformed', severity: 'error' }];
    const entries = parts.map((part) => partEntry(part, target.encoding));
    value = fields(ctx, entries, target.schema, { ...ctx.form, lenient: true }, issues);
  } else if (media.type.startsWith('text/')) {
    value = body.toString('utf8');
  } else {
    return [];
  }
  if (target.schema !== undefined) issues.push(...ctx.validator.check(target.ptr, value, 'body'));
  return issues;
}

function fields(ctx: BodyContext, entries: Entry[], schema: unknown, formats: Formats, issues: Issue[]): Obj {
  const mctx: MaterializeContext = { doc: ctx.doc, formats, issues, where: 'body', label: 'Form field' };
  const { value } = formFields(mctx, entries, schema);
  return value;
}

export interface Part {
  name: string;
  filename: string | null;
  type: string | null;
  data: Buffer;
}

function partEntry(part: Part, encoding: Obj): Entry {
  const declared = isObj(encoding[part.name]) ? (encoding[part.name] as Obj).contentType : undefined;
  const type = (part.type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (part.filename !== null) return { key: part.name, value: `<file ${part.filename}>`, text: false };
  if (isJsonType(type) || (typeof declared === 'string' && isJsonType(declared.toLowerCase()) && type !== 'text/plain')) {
    try {
      return { key: part.name, value: JSON.parse(part.data.toString('utf8')), text: false };
    } catch {}
  }
  if (type && type !== 'text/plain' && !type.startsWith('text/')) return { key: part.name, value: '<binary>', text: false };
  return { key: part.name, value: part.data.toString('utf8'), text: true };
}

export function parseMultipart(body: Buffer, boundary: string): Part[] | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delimiter);
  if (pos === -1) return null;
  while (true) {
    pos += delimiter.length;
    if (body.subarray(pos, pos + 2).toString() === '--') return parts;
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    else if (body[pos] === 10) pos += 1;
    const next = body.indexOf(delimiter, pos);
    if (next === -1) return null;
    let end = next;
    if (body[end - 1] === 10) end--;
    if (body[end - 1] === 13) end--;
    const chunk = body.subarray(pos, end);
    let split = chunk.indexOf('\r\n\r\n');
    let skip = 4;
    if (split === -1) {
      split = chunk.indexOf('\n\n');
      skip = 2;
    }
    if (split === -1) return null;
    const head = chunk.subarray(0, split).toString('utf8');
    const data = chunk.subarray(split + skip);
    let name: string | null = null;
    let filename: string | null = null;
    let type: string | null = null;
    for (const line of head.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'content-type') type = value;
      if (key === 'content-disposition') {
        name = dispositionParam(value, 'name');
        filename = dispositionParam(value, 'filename*') ?? dispositionParam(value, 'filename');
      }
    }
    if (name === null) return null;
    parts.push({ name, filename, type, data });
    pos = next;
  }
}

function dispositionParam(header: string, key: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${key.replace('*', '\\*')}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i');
  const match = header.match(re);
  if (!match) return null;
  const value = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : (match[2] ?? '').trim();
  if (key.endsWith('*')) {
    const tick = value.indexOf("''");
    try {
      return decodeURIComponent(tick === -1 ? value : value.slice(tick + 2));
    } catch {
      return value;
    }
  }
  return value;
}
