import { isJsonType, mediaMatches } from './body.ts';
import { type GenerateOptions, conforms, generate } from './generate.ts';
import { type Obj, deref, isObj } from './spec.ts';

export interface Preferences {
  code: string | null;
  example: string | null;
}

export interface PlannedResponse {
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: unknown;
  hasBody: boolean;
  stream: 'sse' | 'ndjson' | null;
  source: 'example' | 'generated' | 'none';
}

export type Plan = { ok: true; response: PlannedResponse } | { ok: false; status: number; message: string };

export function parsePrefer(header: string | string[] | undefined): Preferences {
  const out: Preferences = { code: null, example: null };
  const text = Array.isArray(header) ? header.join(',') : header;
  if (!text) return out;
  for (const part of text.split(/[,;]/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '');
    if (key === 'code') out.code = value;
    if (key === 'example') out.example = value;
  }
  return out;
}

function pickStatus(responses: Obj, wanted: string | null): { key: string; status: number } | null {
  const keys = Object.keys(responses);
  if (wanted !== null) {
    if (!/^\d{3}$/.test(wanted)) return null;
    if (responses[wanted] !== undefined) return { key: wanted, status: Number(wanted) };
    const range = `${wanted[0]}XX`;
    const rangeKey = keys.find((k) => k.toUpperCase() === range);
    if (rangeKey) return { key: rangeKey, status: Number(wanted) };
    if (responses.default !== undefined) return { key: 'default', status: Number(wanted) };
    return null;
  }
  const exact = keys.filter((k) => /^2\d\d$/.test(k)).sort();
  if (exact[0]) return { key: exact[0], status: Number(exact[0]) };
  const range = keys.find((k) => k.toUpperCase() === '2XX');
  if (range) return { key: range, status: 200 };
  if (responses.default !== undefined) return { key: 'default', status: 200 };
  const any = keys.filter((k) => /^\d\d\d$/.test(k)).sort()[0];
  if (any) return { key: any, status: Number(any) };
  return null;
}

function negotiate(content: Obj, accept: string | undefined): string | null {
  const types = Object.keys(content);
  if (types.length === 0) return null;
  if (accept) {
    const wanted = accept
      .split(',')
      .map((part) => {
        const [type, ...params] = part.split(';');
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        return { type: (type ?? '').trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
      })
      .filter((w) => w.type && w.q > 0)
      .sort((a, b) => b.q - a.q);
    for (const w of wanted) {
      if (w.type === '*/*') break;
      const hit = types.find((t) => mediaMatches(w.type, t.split(';')[0]?.trim().toLowerCase() ?? ''));
      if (hit) return hit;
    }
  }
  return types.find((t) => isJsonType(t.split(';')[0]?.trim().toLowerCase() ?? '')) ?? types[0] ?? null;
}

function exampleValue(doc: Obj, media: Obj, name: string | null): { found: boolean; value: unknown } {
  if (name !== null && isObj(media.examples) && media.examples[name] !== undefined) {
    const ex = deref(doc, media.examples[name]);
    if (isObj(ex) && 'value' in ex) return { found: true, value: structuredClone(ex.value) };
  }
  if (media.example !== undefined) return { found: true, value: structuredClone(media.example) };
  if (isObj(media.examples)) {
    for (const raw of Object.values(media.examples)) {
      const ex = deref(doc, raw);
      if (isObj(ex) && 'value' in ex) return { found: true, value: structuredClone(ex.value) };
    }
  }
  return { found: false, value: undefined };
}

function headerText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(headerText).join(',');
  if (isObj(value)) return Object.entries(value).map(([k, v]) => `${k},${headerText(v)}`).join(',');
  return String(value);
}

export function planResponse(doc: Obj, operation: Obj, prefer: Preferences, accept: string | undefined, gen: Partial<GenerateOptions>): Plan {
  const responses = isObj(operation.responses) ? operation.responses : {};
  const picked = pickStatus(responses, prefer.code);
  if (!picked) {
    if (prefer.code !== null) return { ok: false, status: 404, message: `The operation defines no response for status ${prefer.code}` };
    return { ok: true, response: { status: 200, headers: {}, contentType: null, body: undefined, hasBody: false, stream: null, source: 'none' } };
  }
  const response = deref(doc, responses[picked.key]);
  const headers: Record<string, string> = {};
  if (isObj(response) && isObj(response.headers)) {
    for (const [name, rawHeader] of Object.entries(response.headers)) {
      if (name.toLowerCase() === 'content-type' || name.toLowerCase() === 'content-length') continue;
      const header = deref(doc, rawHeader);
      if (!isObj(header)) continue;
      let value: unknown = header.example;
      if (value === undefined && isObj(header.examples)) {
        const first = deref(doc, Object.values(header.examples)[0]);
        if (isObj(first)) value = first.value;
      }
      if (value === undefined && header.schema !== undefined) value = generate(doc, header.schema, gen);
      if (value === undefined || (header.required !== true && value === null)) continue;
      headers[name.toLowerCase()] = headerText(value);
    }
  }
  const content = isObj(response) && isObj(response.content) ? response.content : {};
  const type = negotiate(content, accept);
  const noBody = picked.status === 204 || picked.status === 304 || picked.status < 200;
  if (!type || noBody) {
    return { ok: true, response: { status: picked.status, headers, contentType: null, body: undefined, hasBody: false, stream: null, source: 'none' } };
  }
  const media = isObj(content[type]) ? (content[type] as Obj) : {};
  const bare = type.split(';')[0]?.trim().toLowerCase() ?? '';
  const stream = bare === 'text/event-stream' ? 'sse' : /ndjson|jsonl|json-seq/.test(bare) ? 'ndjson' : null;
  const example = exampleValue(doc, media, prefer.example);
  const usable = example.found && (prefer.example !== null || media.schema === undefined || stream !== null || conforms(doc, media.schema, example.value));
  let body: unknown;
  let source: PlannedResponse['source'] = 'example';
  if (usable) body = example.value;
  else if (stream && isObj(media.itemSchema)) {
    body = generate(doc, media.itemSchema, gen);
    source = 'generated';
  } else if (media.schema !== undefined) {
    body = generate(doc, media.schema, gen);
    source = 'generated';
  } else if (isJsonType(bare)) {
    body = {};
    source = 'generated';
  } else {
    body = '';
    source = 'none';
  }
  return { ok: true, response: { status: picked.status, headers, contentType: concreteType(doc, type, media, body), body, hasBody: true, stream, source } };
}

export function concreteType(doc: Obj, type: string, media: Obj, body: unknown): string {
  const bare = type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!bare.includes('*')) return type;
  const schema = deref(doc, media.schema);
  const binary = isObj(schema) && (schema.format === 'binary' || typeof schema.contentMediaType === 'string');
  if (typeof body !== 'string') return bare === '*/*' || bare === 'application/*' ? 'application/json' : 'application/octet-stream';
  if (binary) return 'application/octet-stream';
  if (bare === '*/*' || bare.startsWith('text/')) return 'text/plain';
  return 'application/octet-stream';
}

export function encodeBody(contentType: string, body: unknown): Buffer {
  const bare = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (isJsonType(bare)) return Buffer.from(JSON.stringify(body === undefined ? null : body, null, 2));
  if (typeof body === 'string') return Buffer.from(body);
  if (bare === 'application/x-www-form-urlencoded' && isObj(body)) {
    return Buffer.from(new URLSearchParams(Object.entries(body).map(([k, v]) => [k, headerText(v)])).toString());
  }
  if (bare.endsWith('xml')) return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${toXml('root', body)}`);
  if (bare.startsWith('text/')) return Buffer.from(typeof body === 'object' ? JSON.stringify(body) : String(body));
  if (body === null || body === undefined || isObj(body) || Array.isArray(body)) return Buffer.from(isObj(body) || Array.isArray(body) ? JSON.stringify(body) : '');
  return Buffer.from(String(body));
}

function toXml(name: string, value: unknown): string {
  const tag = /^[A-Za-z_][\w.-]*$/.test(name) ? name : 'item';
  if (Array.isArray(value)) return value.map((item) => toXml(tag, item)).join('');
  if (isObj(value)) return `<${tag}>${Object.entries(value).map(([k, v]) => toXml(k, v)).join('')}</${tag}>`;
  const text = value === null || value === undefined ? '' : String(value);
  return `<${tag}>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${tag}>`;
}

export interface StreamEvent {
  event: string | null;
  data: string;
  id: string | null;
}

export function streamEvents(body: unknown, kind: 'sse' | 'ndjson', count: number): StreamEvent[] {
  if (typeof body === 'string') {
    return [{ event: null, data: body, id: null }];
  }
  if (Array.isArray(body) && body.length > 0 && body.every((item) => isObj(item) && 'data' in item) && kind === 'sse') {
    return body.map((item) => ({
      event: typeof item.event === 'string' ? item.event : null,
      data: typeof item.data === 'string' ? item.data : JSON.stringify(item.data),
      id: item.id !== undefined ? String(item.id) : null,
    }));
  }
  if (Array.isArray(body) && body.length > 0) return body.map((item) => ({ event: null, data: JSON.stringify(item), id: null }));
  const out: StreamEvent[] = [];
  for (let i = 0; i < count; i++) out.push({ event: null, data: JSON.stringify(body), id: null });
  return out;
}
