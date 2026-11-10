import { schemaTypes } from './schema.ts';
import { type Obj, deref, isObj } from './spec.ts';
import type { Issue } from './validator.ts';

export const ARRAY_FORMATS = ['auto', 'repeat', 'comma', 'space', 'pipe', 'brackets', 'indices'] as const;
export const OBJECT_FORMATS = ['auto', 'flat', 'flat-comma', 'brackets', 'dots'] as const;

export type ArrayFormat = (typeof ARRAY_FORMATS)[number];
export type ObjectFormat = (typeof OBJECT_FORMATS)[number];

export interface Formats {
  array: Exclude<ArrayFormat, 'auto'>;
  object: Exclude<ObjectFormat, 'auto'>;
  lenient?: boolean;
}

export interface Entry {
  key: string;
  value: unknown;
  text: boolean;
}

export interface FormNode {
  values: Entry[];
  pushed: Entry[];
  children: Map<string, FormNode>;
  styles: Set<'dots' | 'brackets'>;
}

export interface Splitter {
  path: string[];
  push: boolean;
  style: 'dots' | 'brackets' | null;
}

export function newNode(): FormNode {
  return { values: [], pushed: [], children: new Map(), styles: new Set() };
}

export function splitKey(rest: string): Splitter | null {
  const path: string[] = [];
  let push = false;
  let style: 'dots' | 'brackets' | null = null;
  let i = 0;
  while (i < rest.length) {
    if (push) return null;
    const c = rest[i];
    if (c === '[') {
      const end = rest.indexOf(']', i);
      if (end === -1) return null;
      const name = rest.slice(i + 1, end);
      if (name === '') push = true;
      else {
        path.push(name);
        if (!/^\d+$/.test(name)) style = style === 'dots' ? 'dots' : 'brackets';
      }
      i = end + 1;
    } else if (c === '.') {
      let end = i + 1;
      while (end < rest.length && rest[end] !== '.' && rest[end] !== '[') end++;
      const name = rest.slice(i + 1, end);
      if (name === '') return null;
      path.push(name);
      style = style === 'brackets' ? 'brackets' : 'dots';
      i = end;
    } else return null;
  }
  return { path, push, style };
}

export function insert(root: FormNode, split: Splitter, entry: Entry): void {
  let node = root;
  if (split.style) root.styles.add(split.style);
  for (const segment of split.path) {
    let next = node.children.get(segment);
    if (!next) {
      next = newNode();
      node.children.set(segment, next);
    }
    node = next;
  }
  (split.push ? node.pushed : node.values).push(entry);
}

export function propertySchema(doc: Obj, schema: unknown, name: string, depth = 0): unknown {
  const node = deref(doc, schema);
  if (!isObj(node) || depth > 20) return undefined;
  if (isObj(node.properties) && node.properties[name] !== undefined) return node.properties[name];
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(node[key])) continue;
    for (const sub of node[key]) {
      const found = propertySchema(doc, sub, name, depth + 1);
      if (found !== undefined) return found;
    }
  }
  if (isObj(node.additionalProperties)) return node.additionalProperties;
  return undefined;
}

export function itemsSchema(doc: Obj, schema: unknown, depth = 0): unknown {
  const node = deref(doc, schema);
  if (!isObj(node) || depth > 20) return undefined;
  if (node.items !== undefined) return node.items;
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(node[key])) continue;
    for (const sub of node[key]) {
      const found = itemsSchema(doc, sub, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const INTEGER = /^-?\d+$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function coerce(doc: Obj, text: string, schema: unknown): unknown {
  const types = schemaTypes(doc, schema);
  if (types.size === 0) return text;
  if (types.has('null') && text === 'null' && !types.has('string')) return null;
  if (types.has('integer') && INTEGER.test(text)) return Number(text);
  if (types.has('number') && NUMBER.test(text)) return Number(text);
  if (types.has('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  if (types.has('string')) return text;
  if ((types.has('object') || types.has('array')) && /^[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function separator(format: Formats['array']): string | null {
  if (format === 'comma') return ',';
  if (format === 'space') return ' ';
  if (format === 'pipe') return '|';
  return null;
}

export interface MaterializeContext {
  doc: Obj;
  formats: Formats;
  issues: Issue[];
  where: string;
  label: string;
}

function mismatch(ctx: MaterializeContext, at: string, detail: string): void {
  ctx.issues.push({
    location: `${ctx.where}.${at}`,
    code: 'serialization',
    message: `${ctx.label} "${at}" is not serialized as expected: ${detail}`,
    severity: 'error',
  });
}

function leaf(ctx: MaterializeContext, entry: Entry, schema: unknown): unknown {
  return entry.text ? coerce(ctx.doc, entry.value as string, schema) : entry.value;
}

function arrayFrom(ctx: MaterializeContext, at: string, values: Entry[], schema: unknown): unknown[] {
  const items = itemsSchema(ctx.doc, schema);
  const sep = separator(ctx.formats.array);
  const out: unknown[] = [];
  if (sep && values.length > 1 && !ctx.formats.lenient) {
    mismatch(ctx, at, `expected one "${ctx.formats.array}" separated value, got ${values.length} repeated keys`);
  }
  for (const entry of values) {
    if (sep && entry.text) {
      const text = entry.value as string;
      for (const part of text === '' ? [] : text.split(sep)) out.push(coerce(ctx.doc, part, items));
    } else out.push(leaf(ctx, entry, items));
  }
  return out;
}

function flatComma(ctx: MaterializeContext, text: string, schema: unknown): Obj {
  const parts = text.split(',');
  const out: Obj = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i] as string;
    out[key] = coerce(ctx.doc, parts[i + 1] as string, propertySchema(ctx.doc, schema, key));
  }
  return out;
}

export function materialize(ctx: MaterializeContext, node: FormNode, schema: unknown, at: string): unknown {
  const types = schemaTypes(ctx.doc, schema);
  if (node.children.size > 0) {
    const keys = [...node.children.keys()];
    if (node.values.length > 0 || node.pushed.length > 0) mismatch(ctx, at, 'value given both directly and as nested keys');
    if (types.has('array') && !types.has('object') && keys.every((k) => /^\d+$/.test(k))) {
      if (ctx.formats.array !== 'indices' && !ctx.formats.lenient) mismatch(ctx, at, `expected "${ctx.formats.array}" array format, got indices`);
      const items = itemsSchema(ctx.doc, schema);
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => materialize(ctx, node.children.get(k) as FormNode, items, `${at}[${k}]`));
    }
    const out: Obj = {};
    for (const [key, sub] of node.children) {
      const childAt = ctx.formats.object === 'brackets' ? `${at}[${key}]` : `${at}.${key}`;
      out[key] = materialize(ctx, sub, propertySchema(ctx.doc, schema, key), childAt);
    }
    return out;
  }
  if (node.pushed.length > 0) {
    if (ctx.formats.array !== 'brackets' && !ctx.formats.lenient) mismatch(ctx, `${at}[]`, `expected "${ctx.formats.array}" array format, got brackets`);
    if (node.values.length > 0) mismatch(ctx, at, 'value given both with and without []');
    const items = itemsSchema(ctx.doc, schema);
    const out = node.pushed.map((entry) => leaf(ctx, entry, items));
    if (!types.has('array') && types.size > 0 && out.length === 1 && ctx.formats.lenient) return out[0];
    return out;
  }
  const values = node.values;
  if (values.length === 0) return undefined;
  const wantsArray = types.has('array');
  const scalarOk = [...types].some((t) => t !== 'array' && t !== 'object' && t !== 'null');
  if (wantsArray && (!scalarOk || values.length > 1 || looksSeparated(ctx, values))) {
    if ((ctx.formats.array === 'brackets' || ctx.formats.array === 'indices') && !ctx.formats.lenient) {
      mismatch(ctx, at, `expected "${ctx.formats.array}" array format`);
    }
    if (ctx.formats.array === 'brackets' || ctx.formats.array === 'indices' || ctx.formats.array === 'repeat') return values.map((entry) => leaf(ctx, entry, itemsSchema(ctx.doc, schema)));
    return arrayFrom(ctx, at, values, schema);
  }
  if (types.has('object') && !scalarOk && ctx.formats.object === 'flat-comma' && values.length === 1 && values[0]?.text) {
    return flatComma(ctx, values[0].value as string, schema);
  }
  if (values.length > 1) {
    if (!ctx.formats.lenient) {
      mismatch(ctx, at, `expected a single value, got ${values.length}`);
      return leaf(ctx, values[0] as Entry, schema);
    }
    return values.map((entry) => leaf(ctx, entry, schema));
  }
  return leaf(ctx, values[0] as Entry, schema);
}

function looksSeparated(ctx: MaterializeContext, values: Entry[]): boolean {
  const sep = separator(ctx.formats.array);
  return sep !== null && values.some((entry) => entry.text && (entry.value as string).includes(sep));
}

export function formFields(ctx: MaterializeContext, entries: Entry[], schema: unknown): { value: Obj; unknown: string[] } {
  const root = newNode();
  const out: Obj = {};
  const unknown: string[] = [];
  const declared = new Set<string>();
  const node = deref(ctx.doc, schema);
  collectProperties(ctx.doc, node, declared);
  for (const entry of entries) {
    const head = entry.key.match(/^[^.[]+/)?.[0] ?? entry.key;
    const rest = entry.key.slice(head.length);
    const split = splitKey(rest);
    if (!split) {
      insert(root, { path: [entry.key], push: false, style: null }, entry);
      continue;
    }
    if (declared.has(entry.key) && rest !== '') {
      insert(root, { path: [entry.key], push: false, style: null }, entry);
      continue;
    }
    if (split.style && !ctx.formats.lenient && split.style !== (ctx.formats.object === 'brackets' ? 'brackets' : 'dots')) {
      mismatch(ctx, entry.key, `expected "${ctx.formats.object}" object format`);
    }
    insert(root, { path: [head, ...split.path], push: split.push, style: split.style }, entry);
  }
  for (const [key, sub] of root.children) {
    const prop = propertySchema(ctx.doc, schema, key);
    if (prop === undefined && declared.size > 0) unknown.push(key);
    out[key] = materialize(ctx, sub, prop, key);
  }
  return { value: out, unknown };
}

function collectProperties(doc: Obj, node: unknown, into: Set<string>, depth = 0): void {
  const resolved = deref(doc, node);
  if (!isObj(resolved) || depth > 20) return;
  if (isObj(resolved.properties)) for (const key of Object.keys(resolved.properties)) into.add(key);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(resolved[key])) for (const sub of resolved[key]) collectProperties(doc, sub, into, depth + 1);
  }
}
