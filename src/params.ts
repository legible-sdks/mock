import {
  type Entry,
  type Formats,
  type FormNode,
  type MaterializeContext,
  coerce,
  insert,
  itemsSchema,
  materialize,
  newNode,
  propertySchema,
  splitKey,
} from './form.ts';
import { schemaTypes } from './schema.ts';
import { type Obj, child, escapeRegExp, isObj } from './spec.ts';
import type { Issue, Validator } from './validator.ts';

export interface Parameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required: boolean;
  schema: unknown;
  ptr: string;
  style: string;
  explode: boolean;
  json: boolean;
}

export interface ParamOverrides {
  array: Formats['array'] | null;
  object: Formats['object'] | null;
}

export interface ParamInput {
  query: Array<[string, string]>;
  path: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

export function readParameter(raw: Obj, ptr: string): Parameter | null {
  const where = raw.in;
  if (where !== 'query' && where !== 'path' && where !== 'header' && where !== 'cookie') return null;
  if (typeof raw.name !== 'string') return null;
  let schema = raw.schema;
  let schemaPtr = child(ptr, 'schema');
  let json = false;
  if (schema === undefined && isObj(raw.content)) {
    const [type, media] = Object.entries(raw.content as Obj)[0] ?? [];
    if (isObj(media)) {
      schema = media.schema;
      schemaPtr = child(ptr, 'content', type as string, 'schema');
      json = /json/i.test(type as string);
    }
  }
  const style = typeof raw.style === 'string' ? raw.style : where === 'query' || where === 'cookie' ? 'form' : 'simple';
  const explode = typeof raw.explode === 'boolean' ? raw.explode : style === 'form';
  return {
    name: raw.name,
    in: where,
    required: where === 'path' ? true : raw.required === true,
    schema,
    ptr: schemaPtr,
    style,
    explode,
    json,
  };
}

function specFormats(param: Parameter, overrides: ParamOverrides): Formats {
  let array: Formats['array'] = 'repeat';
  if (param.style === 'spaceDelimited') array = 'space';
  else if (param.style === 'pipeDelimited') array = 'pipe';
  else if (!param.explode) array = 'comma';
  let object: Formats['object'] = 'flat';
  if (param.style === 'deepObject') object = 'brackets';
  else if (!param.explode) object = 'flat-comma';
  return { array: overrides.array ?? array, object: overrides.object ?? object };
}

export interface ParamContext {
  doc: Obj;
  validator: Validator;
  overrides: ParamOverrides;
  strict: boolean;
}

export function validateParameters(ctx: ParamContext, params: Parameter[], input: ParamInput): Issue[] {
  const issues: Issue[] = [];
  const consumed = new Set<number>();
  const queryNames = new Set(params.filter((p) => p.in === 'query').map((p) => p.name));
  for (const param of params) {
    let value: unknown;
    const location = `${param.in}.${param.name}`;
    if (param.in === 'query') value = readQuery(ctx, param, input.query, consumed, queryNames, issues);
    else if (param.in === 'path') value = readSimple(ctx, param, input.path[param.name]);
    else if (param.in === 'header') {
      if (IGNORED_HEADERS.has(param.name.toLowerCase())) continue;
      const raw = input.headers[param.name.toLowerCase()];
      value = readSimple(ctx, param, Array.isArray(raw) ? raw.join(',') : raw);
    } else value = readCookie(ctx, param, input.headers.cookie);
    if (value === undefined) {
      if (param.required) {
        issues.push({ location, code: 'required', message: `Required ${param.in} parameter "${param.name}" is missing`, severity: 'error' });
      }
      continue;
    }
    if (param.schema !== undefined) issues.push(...ctx.validator.check(param.ptr, value, location));
  }
  input.query.forEach(([key], i) => {
    if (consumed.has(i)) return;
    const normalized = key.replace(/\[\]$/, '').replace(/\[([^\]]+)\]/g, '.$1');
    if (normalized !== key && queryNames.has(normalized)) {
      issues.push(serialization(key, normalized, 'expected the parameter name exactly as declared'));
      return;
    }
    issues.push({
      location: `query.${key}`,
      code: 'unknown-parameter',
      message: `Query parameter "${key}" is not declared on this operation`,
      severity: ctx.strict ? 'error' : 'warning',
    });
  });
  return issues;
}

function readQuery(
  ctx: ParamContext,
  param: Parameter,
  query: Array<[string, string]>,
  consumed: Set<number>,
  declared: Set<string>,
  issues: Issue[],
): unknown {
  const formats = specFormats(param, ctx.overrides);
  const name = param.name;
  const types = schemaTypes(ctx.doc, param.schema);
  const objectOnly = types.has('object') && ![...types].some((t) => t !== 'object' && t !== 'null');
  const items = types.has('array') ? itemsSchema(ctx.doc, param.schema) : undefined;
  const arrayOfObjects = items !== undefined && !types.has('object') && schemaTypes(ctx.doc, items).has('object');
  const mctx: MaterializeContext = { doc: ctx.doc, formats, issues, where: 'query', label: 'Query parameter' };
  if (param.json) {
    const index = query.findIndex(([key]) => key === name);
    if (index === -1) return undefined;
    consumed.add(index);
    try {
      return JSON.parse(query[index]?.[1] as string);
    } catch {
      return query[index]?.[1];
    }
  }
  if (objectOnly && formats.object === 'flat') {
    const out: Obj = {};
    let found = false;
    query.forEach(([key, value], i) => {
      if (declared.has(key) || consumed.has(i)) return;
      const prop = propertySchema(ctx.doc, param.schema, key);
      if (prop === undefined) return;
      consumed.add(i);
      found = true;
      const prev = out[key];
      const next = coerce(ctx.doc, value, schemaTypes(ctx.doc, prop).has('array') ? itemsSchema(ctx.doc, prop) : prop);
      out[key] = prev === undefined ? (schemaTypes(ctx.doc, prop).has('array') ? [next] : next) : [...(Array.isArray(prev) ? prev : [prev]), next];
    });
    return found ? out : undefined;
  }
  const root: FormNode = newNode();
  let found = false;
  query.forEach(([key, value], i) => {
    if (consumed.has(i)) return;
    if (key !== name && !key.startsWith(`${name}[`) && !key.startsWith(`${name}.`)) return;
    if (key !== name && declared.has(key)) return;
    const split = splitKey(key.slice(name.length));
    if (!split) return;
    consumed.add(i);
    found = true;
    if (split.style && arrayOfObjects) {
      insert(root, split, { key, value, text: true });
      return;
    }
    if (split.style) {
      const expected = formats.object === 'brackets' ? 'brackets' : 'dots';
      if (!objectOnly && !types.has('object')) {
        issues.push(serialization(key, name, 'parameter is not an object'));
      } else if (split.style !== expected || formats.object === 'flat' || formats.object === 'flat-comma') {
        issues.push(serialization(key, name, `expected "${formats.object}" object format`));
      }
    }
    insert(root, split, { key, value, text: true });
  });
  if (!found) return undefined;
  if (arrayOfObjects && root.children.size > 0) {
    if ([...root.children.keys()].every((k) => /^\d+$/.test(k))) return materialize({ ...mctx, formats: { ...formats, array: 'indices' } }, root, param.schema, name);
    return [materialize(mctx, root, items, name)];
  }
  return materialize(mctx, root, param.schema, name);
}

function serialization(key: string, name: string, detail: string): Issue {
  return {
    location: `query.${key}`,
    code: 'serialization',
    message: `Query key "${key}" seems to encode "${name}" in another style: ${detail}`,
    severity: 'error',
  };
}

function readSimple(ctx: ParamContext, param: Parameter, raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  let text = raw;
  if (param.style === 'label' && text.startsWith('.')) text = text.slice(1);
  if (param.style === 'matrix') text = text.replace(new RegExp(`^;${escapeRegExp(param.name)}=`), '');
  if (param.json) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const types = schemaTypes(ctx.doc, param.schema);
  const sep = param.style === 'label' && param.explode ? '.' : ',';
  if (types.has('array') && ![...types].some((t) => t !== 'array' && t !== 'null')) {
    const items = itemsSchema(ctx.doc, param.schema);
    return text === '' ? [] : text.split(sep).map((part) => coerce(ctx.doc, part, items));
  }
  if (types.has('object') && ![...types].some((t) => t !== 'object' && t !== 'null')) {
    const out: Obj = {};
    if (param.explode) {
      for (const pair of text.split(sep)) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq);
        out[key] = coerce(ctx.doc, pair.slice(eq + 1), propertySchema(ctx.doc, param.schema, key));
      }
    } else {
      const parts = text.split(sep);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const key = parts[i] as string;
        out[key] = coerce(ctx.doc, parts[i + 1] as string, propertySchema(ctx.doc, param.schema, key));
      }
    }
    return out;
  }
  return coerce(ctx.doc, text, param.schema);
}

function readCookie(ctx: ParamContext, param: Parameter, header: string | string[] | undefined): unknown {
  if (header === undefined) return undefined;
  const text = Array.isArray(header) ? header.join('; ') : header;
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== param.name) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    return readSimple(ctx, { ...param, style: 'simple' }, value);
  }
  return undefined;
}
