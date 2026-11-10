import { type Obj, isObj } from './spec.ts';

export interface GenerateOptions {
  arrayMin: number;
  arrayMax: number;
  maxDepth: number;
}

const DEFAULTS: GenerateOptions = { arrayMin: 1, arrayMax: 1, maxDepth: 12 };

const STRING_FORMATS: Record<string, string> = {
  'date-time': '2020-01-31T23:59:59Z',
  date: '2020-01-31',
  time: '23:59:59',
  duration: 'P1D',
  email: 'user@example.com',
  'idn-email': 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  'uri-reference': 'https://example.com',
  iri: 'https://example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  ipv6: '::1',
  uuid: '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e',
  byte: 'ZXhhbXBsZQ==',
  binary: 'string',
  password: 'password',
  regex: '.*',
  'json-pointer': '/',
};

interface State {
  doc: Obj;
  options: GenerateOptions;
  stack: string[];
}

export function generate(doc: Obj, schema: unknown, options: Partial<GenerateOptions> = {}): unknown {
  return gen({ doc, options: { ...DEFAULTS, ...options }, stack: [] }, schema, 0);
}

export function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function conforms(doc: Obj, schema: unknown, value: unknown, depth = 0, seen: ReadonlySet<string> = new Set()): boolean {
  if (depth > 24 || schema === true || schema === undefined) return true;
  if (schema === false) return false;
  if (!isObj(schema)) return true;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return true;
    const target = resolve(doc, schema.$ref);
    return target === undefined ? true : conforms(doc, target, value, depth + 1, new Set([...seen, schema.$ref]));
  }
  if (value === null && (schema.nullable === true || typesOf(schema).includes('null'))) return true;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((s: unknown) => conforms(doc, s, value, depth + 1, seen))) return false;
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0 && !schema[key].some((s: unknown) => conforms(doc, s, value, depth + 1, seen))) return false;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some((v: unknown) => JSON.stringify(v) === JSON.stringify(value))) return false;
  const declaredTypes = typesOf(schema);
  const types = declaredTypes.length > 0 ? declaredTypes : isObj(schema.properties) ? ['object'] : schema.items !== undefined ? ['array'] : [];
  const actual = jsonType(value);
  if (types.length > 0 && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return false;
  if (actual === 'string' && schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value as string)) return false;
  if (actual === 'string' && schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value as string) || Number.isNaN(Date.parse(value as string)))) return false;
  if (actual === 'object' && isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required) && schema.required.some((r: unknown) => typeof r === 'string' && isObj(props[r]) && !(r in value))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (props[key] !== undefined && !conforms(doc, props[key], item, depth + 1, seen)) return false;
      if (props[key] === undefined && isObj(schema.additionalProperties) && !conforms(doc, schema.additionalProperties, item, depth + 1, seen)) return false;
    }
  }
  if (actual === 'array' && Array.isArray(value) && schema.items !== undefined) {
    return value.every((item) => conforms(doc, schema.items, item, depth + 1, seen));
  }
  return true;
}

function typesOf(node: Obj): string[] {
  if (typeof node.type === 'string') return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((t: unknown): t is string => typeof t === 'string');
  return [];
}

function gen(state: State, schema: unknown, depth: number): unknown {
  if (schema === true || schema === undefined) return {};
  if (!isObj(schema)) return null;
  let node: unknown = schema;
  let pushed = 0;
  const firstRef = isObj(schema) && typeof schema.$ref === 'string' ? (schema.$ref as string) : undefined;
  while (isObj(node) && typeof node.$ref === 'string' && node.$ref.startsWith('#')) {
    const ref = node.$ref as string;
    if (state.stack.filter((r) => r === ref).length >= 2) {
      state.stack.length -= pushed;
      return empty(state, node);
    }
    state.stack.push(ref);
    pushed++;
    const target = resolve(state.doc, ref);
    if (target === undefined) break;
    const siblings = { ...node };
    delete siblings.$ref;
    node = Object.keys(siblings).length > 0 && isObj(target) ? { ...target, ...pickExamples(siblings) } : target;
  }
  try {
    const value = genNode(state, node, depth);
    const tag = firstRef !== undefined ? variantTags(state.doc).get(firstRef) : undefined;
    if (tag && isObj(value) && typeof value[tag.prop] === 'string' && !constrained(state.doc, schema, tag.prop) && !exampled(state.doc, schema, tag.prop)) value[tag.prop] = tag.value;
    return value;
  } finally {
    state.stack.length -= pushed;
  }
}

const VARIANT_TAGS = new WeakMap<Obj, Map<string, { prop: string; value: string }>>();

function variantTags(doc: Obj): Map<string, { prop: string; value: string }> {
  let tags = VARIANT_TAGS.get(doc);
  if (tags) return tags;
  tags = new Map();
  const found = tags;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 60 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = node as Obj;
    if (isObj(obj.discriminator) && typeof obj.discriminator.propertyName === 'string') {
      const prop = obj.discriminator.propertyName as string;
      const mapped = new Set<string>();
      for (const [value, target] of Object.entries(isObj(obj.discriminator.mapping) ? obj.discriminator.mapping : {})) {
        if (typeof target !== 'string') continue;
        const ref = target.startsWith('#') ? target : `#/components/schemas/${target}`;
        mapped.add(ref);
        if (!found.has(ref)) found.set(ref, { prop, value });
      }
      for (const key of ['oneOf', 'anyOf']) {
        for (const variant of Array.isArray(obj[key]) ? obj[key] : []) {
          if (!isObj(variant) || typeof variant.$ref !== 'string' || mapped.has(variant.$ref) || found.has(variant.$ref)) continue;
          found.set(variant.$ref, { prop, value: variant.$ref.split('/').pop() as string });
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) if (key !== 'example' && key !== 'examples') visit(value, depth + 1);
  };
  visit(doc.components, 0);
  VARIANT_TAGS.set(doc, tags);
  return tags;
}

function exampled(doc: Obj, variant: unknown, prop: string): boolean {
  const target = isObj(variant) && typeof variant.$ref === 'string' ? resolve(doc, variant.$ref) : variant;
  const own = isObj(target) && isObj(target.properties) ? target.properties[prop] : undefined;
  return isObj(own) && (own.example !== undefined || own.default !== undefined);
}

function pickExamples(siblings: Obj): Obj {
  const out: Obj = {};
  for (const key of ['example', 'examples', 'default', 'const', 'nullable']) if (siblings[key] !== undefined) out[key] = siblings[key];
  return out;
}

function resolve(doc: Obj, ref: string): unknown {
  let node: any = doc;
  for (const part of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function empty(state: State, node: unknown): unknown {
  const resolved = isObj(node) && typeof node.$ref === 'string' ? resolve(state.doc, node.$ref) : node;
  if (!isObj(resolved)) return null;
  const types = typesOf(resolved);
  if (types.includes('null') || resolved.nullable === true) return null;
  if (types.includes('array')) return [];
  return {};
}

function genNode(state: State, node: unknown, depth: number): unknown {
  if (node === true) return {};
  if (!isObj(node)) return null;
  const fits = (value: unknown): boolean => conforms(state.doc, { ...node, example: undefined, examples: undefined, default: undefined }, value);
  if (node.example !== undefined && fits(node.example)) return structuredClone(node.example);
  if (Array.isArray(node.examples) && node.examples.length > 0 && fits(node.examples[0])) return structuredClone(node.examples[0]);
  if (node.const !== undefined) return structuredClone(node.const);
  if (node.default !== undefined && fits(node.default)) return structuredClone(node.default);
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const declared = typesOf(node);
    const typed = (v: unknown): boolean => declared.length === 0 || declared.includes(jsonType(v)) || (jsonType(v) === 'integer' && declared.includes('number'));
    const value = node.enum.find((v: unknown) => v !== null && typed(v)) ?? node.enum.find((v: unknown) => v !== null);
    return structuredClone(value === undefined ? node.enum[0] : value);
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) return genAllOf(state, node, depth);
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(node[key]) || node[key].length === 0) continue;
    const variants = node[key] as unknown[];
    const pick = variants.find((v) => !isNullSchema(state.doc, v)) ?? variants[0];
    const value = gen(state, pick, depth);
    if (isObj(value) && isObj(node.discriminator) && typeof node.discriminator.propertyName === 'string') {
      const tag = discriminatorValue(state.doc, node.discriminator, pick);
      const prop = node.discriminator.propertyName as string;
      if (tag !== undefined && (value[prop] === undefined || !constrained(state.doc, pick, prop))) value[prop] = tag;
    }
    if (isObj(value) && isObj(node.properties)) return { ...genObject(state, node, depth), ...value };
    return value;
  }
  const types = typesOf(node).filter((t) => t !== 'null');
  let type = types[0];
  if (!type) {
    if (typesOf(node).includes('null')) return null;
    if (isObj(node.properties) || node.additionalProperties !== undefined) type = 'object';
    else if (node.items !== undefined) type = 'array';
    else return {};
  }
  switch (type) {
    case 'object':
      return genObject(state, node, depth);
    case 'array':
      return genArray(state, node, depth);
    case 'string':
      return genString(node);
    case 'integer':
      return genNumber(node, true);
    case 'number':
      return genNumber(node, false);
    case 'boolean':
      return true;
    default:
      return null;
  }
}

function isNullSchema(doc: Obj, schema: unknown): boolean {
  const node = isObj(schema) && typeof schema.$ref === 'string' ? resolve(doc, schema.$ref) : schema;
  if (!isObj(node)) return false;
  const types = typesOf(node);
  return types.length === 1 && types[0] === 'null';
}

function constrained(doc: Obj, variant: unknown, prop: string): boolean {
  const target = isObj(variant) && typeof variant.$ref === 'string' ? resolve(doc, variant.$ref) : variant;
  const own = isObj(target) && isObj(target.properties) ? target.properties[prop] : undefined;
  const resolved = isObj(own) && typeof own.$ref === 'string' ? resolve(doc, own.$ref) : own;
  return isObj(resolved) && (resolved.const !== undefined || Array.isArray(resolved.enum));
}

function discriminatorValue(doc: Obj, discriminator: Obj, variant: unknown): string | undefined {
  if (!isObj(variant) || typeof variant.$ref !== 'string') return undefined;
  const ref = variant.$ref as string;
  if (isObj(discriminator.mapping)) {
    for (const [value, target] of Object.entries(discriminator.mapping)) {
      if (target === ref || `#/components/schemas/${target}` === ref) return value;
    }
  }
  const target = resolve(doc, ref);
  const prop = isObj(target) && isObj(target.properties) ? target.properties[discriminator.propertyName] : undefined;
  const resolved = isObj(prop) && typeof prop.$ref === 'string' ? resolve(doc, prop.$ref) : prop;
  if (isObj(resolved)) {
    if (resolved.const !== undefined) return String(resolved.const);
    if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return String(resolved.enum[0]);
  }
  return ref.split('/').pop();
}

function genAllOf(state: State, node: Obj, depth: number): unknown {
  let merged: unknown = undefined;
  for (const part of node.allOf as unknown[]) {
    const value = gen(state, part, depth);
    if (isObj(value) && (merged === undefined || isObj(merged))) merged = { ...(merged as Obj | undefined), ...value };
    else if (merged === undefined) merged = value;
  }
  if (isObj(node.properties)) {
    const own = genObject(state, node, depth);
    return isObj(merged) ? { ...merged, ...own } : own;
  }
  return merged ?? {};
}

function genObject(state: State, node: Obj, depth: number): Obj {
  const out: Obj = {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const props = isObj(node.properties) ? node.properties : {};
  for (const [name, sub] of Object.entries(props)) {
    if (depth >= state.options.maxDepth && !required.has(name)) continue;
    if (!required.has(name) && recursesInto(state, sub)) continue;
    const resolved = isObj(sub) && typeof sub.$ref === 'string' ? resolve(state.doc, sub.$ref) : sub;
    if (isObj(resolved) && resolved.writeOnly === true) continue;
    out[name] = gen(state, sub, depth + 1);
  }
  return out;
}

function recursesInto(state: State, sub: unknown): boolean {
  if (!isObj(sub)) return false;
  if (typeof sub.$ref === 'string') {
    if (seenTwice(state, sub.$ref)) return true;
    const target = resolve(state.doc, sub.$ref);
    return isObj(target) && isObj(target.items) && typeof target.items.$ref === 'string' && seenTwice(state, target.items.$ref);
  }
  return isObj(sub.items) && typeof sub.items.$ref === 'string' && seenTwice(state, sub.items.$ref);
}

function seenTwice(state: State, ref: string): boolean {
  return state.stack.filter((r) => r === ref).length >= 2;
}

function genArray(state: State, node: Obj, depth: number): unknown[] {
  if (depth >= state.options.maxDepth) return [];
  let count = Math.max(state.options.arrayMin, state.options.arrayMax);
  if (typeof node.minItems === 'number') count = Math.max(count, node.minItems);
  if (typeof node.maxItems === 'number') count = Math.min(count, node.maxItems);
  if (Array.isArray(node.prefixItems)) return node.prefixItems.map((item: unknown) => gen(state, item, depth + 1));
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(gen(state, node.items, depth + 1));
  return out;
}

function genString(node: Obj): string {
  let value = typeof node.format === 'string' && STRING_FORMATS[node.format] ? (STRING_FORMATS[node.format] as string) : 'string';
  if (typeof node.minLength === 'number' && value.length < node.minLength) value = value.padEnd(node.minLength, 'x');
  if (typeof node.maxLength === 'number' && value.length > node.maxLength) value = value.slice(0, node.maxLength);
  return value;
}

function genNumber(node: Obj, integer: boolean): number {
  let value = 0;
  const min = typeof node.minimum === 'number' ? node.minimum : typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum + (integer ? 1 : 0.5) : undefined;
  const max = typeof node.maximum === 'number' ? node.maximum : typeof node.exclusiveMaximum === 'number' ? node.exclusiveMaximum - (integer ? 1 : 0.5) : undefined;
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  if (node.exclusiveMinimum === true && typeof node.minimum === 'number' && value <= node.minimum) value = node.minimum + (integer ? 1 : 0.5);
  if (typeof node.multipleOf === 'number' && node.multipleOf > 0 && value % node.multipleOf !== 0) value = Math.ceil(value / node.multipleOf) * node.multipleOf;
  return integer ? Math.ceil(value) : value;
}
