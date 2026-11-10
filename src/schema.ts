import { type Obj, type Spec, child, deref, getPointer, isObj } from './spec.ts';

export const DEFS_ID = 'mock:defs';

const COPY_KEYWORDS = [
  'type',
  'enum',
  'const',
  'required',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minProperties',
  'maxProperties',
  'dependentRequired',
] as const;

const SCHEMA_KEYWORDS = ['not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'] as const;

const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'prefixItems'] as const;

const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', 'dependentSchemas', '$defs'] as const;

export const CONTENT_KEYWORDS = new Set([
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

export const KNOWN_FORMATS = new Set([
  'date',
  'time',
  'date-time',
  'duration',
  'uri',
  'uri-reference',
  'uri-template',
  'url',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'regex',
  'uuid',
  'json-pointer',
  'relative-json-pointer',
  'byte',
  'int32',
  'int64',
  'float',
  'double',
]);

export interface ConvertOptions {
  strictOneOf: boolean;
  context: 'request' | 'response';
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

export class SchemaConverter {
  readonly defs: Obj = {};
  private readonly keys = new Map<string, string>();
  private readonly spec: Spec;
  private readonly options: ConvertOptions;

  constructor(spec: Spec, options: Partial<ConvertOptions> = {}) {
    this.spec = spec;
    this.options = { strictOneOf: false, context: 'request', ...options };
  }

  convert(node: unknown, ptr: string): Obj | boolean {
    if (typeof node === 'boolean') return node;
    if (!isObj(node)) return true;
    if (typeof node.$ref === 'string') return this.convertRef(node, ptr);
    return this.convertSchema(node, ptr);
  }

  private refKey(target: string): string {
    let key = this.keys.get(target);
    if (key) return key;
    key = `s${this.keys.size}`;
    this.keys.set(target, key);
    const resolved = getPointer(this.spec.doc, target);
    this.defs[key] = true;
    this.defs[key] = this.convert(resolved, target);
    return key;
  }

  private convertRef(node: Obj, ptr: string): Obj | boolean {
    const ref = node.$ref as string;
    if (!ref.startsWith('#')) return true;
    if (getPointer(this.spec.doc, ref) === undefined) return true;
    const key = this.refKey(ref.slice(1) === '' ? '#' : ref);
    const out: Obj = { $ref: `${DEFS_ID}#/$defs/${key}` };
    const siblings = { ...node };
    delete siblings.$ref;
    delete siblings.type;
    const nullableRef = siblings.nullable === true;
    delete siblings.nullable;
    const rest = this.convertSchema(siblings, ptr);
    const merged = isObj(rest) && Object.keys(rest).length > 0 ? { allOf: [out, rest] } : out;
    return nullableRef ? { anyOf: [merged, { type: 'null' }] } : merged;
  }

  private convertSchema(node: Obj, ptr: string): Obj {
    const out: Obj = {};
    for (const key of COPY_KEYWORDS) {
      if (node[key] !== undefined) out[key] = structuredClone(node[key]);
    }
    if (typeof node.format === 'string' && KNOWN_FORMATS.has(node.format)) out.format = node.format;
    if (this.spec.version === '3.0' || typeof node.exclusiveMinimum === 'boolean' || typeof node.exclusiveMaximum === 'boolean') {
      for (const [flag, bound] of [
        ['exclusiveMinimum', 'minimum'],
        ['exclusiveMaximum', 'maximum'],
      ] as const) {
        if (typeof node[flag] === 'boolean') {
          delete out[flag];
          if (node[flag] && typeof node[bound] === 'number') {
            out[flag] = node[bound];
            delete out[bound];
          }
        }
      }
    }
    if (out.type !== undefined) {
      const types = (Array.isArray(out.type) ? out.type : [out.type])
        .map((t: unknown) => (typeof t === 'string' ? t.toLowerCase() : t))
        .filter((t: unknown): t is string => typeof t === 'string' && JSON_TYPES.has(t));
      if (types.length === 0) delete out.type;
      else out.type = Array.isArray(out.type) ? types : types[0];
      if (types.includes('string') && Array.isArray(out.enum)) {
        const spelled = out.enum.filter((v: unknown) => typeof v === 'number' || typeof v === 'boolean').map(String);
        if (spelled.length > 0) out.enum = [...new Set([...out.enum, ...spelled])];
      }
    }
    for (const key of SCHEMA_KEYWORDS) {
      if (node[key] !== undefined) out[key] = this.convert(node[key], child(ptr, key));
    }
    for (const key of SCHEMA_LIST_KEYWORDS) {
      if (Array.isArray(node[key])) out[key] = node[key].map((item: unknown, i: number) => this.convert(item, child(ptr, key, i)));
    }
    for (const key of SCHEMA_MAP_KEYWORDS) {
      if (!isObj(node[key])) continue;
      const map: Obj = {};
      for (const [name, sub] of Object.entries(node[key] as Obj)) map[name] = this.convert(sub, child(ptr, key, name));
      out[key] = map;
    }
    if (node.items !== undefined) {
      if (Array.isArray(node.items)) {
        out.prefixItems = node.items.map((item: unknown, i: number) => this.convert(item, child(ptr, 'items', i)));
      } else {
        out.items = this.convert(node.items, child(ptr, 'items'));
      }
    }
    if (node.additionalProperties !== undefined) {
      out.additionalProperties = this.convert(node.additionalProperties, child(ptr, 'additionalProperties'));
    }
    const arrayOnly = out.type === 'array' || (Array.isArray(out.type) && out.type.includes('array') && out.type.every((t: string) => t === 'array' || t === 'null'));
    if (arrayOnly && Array.isArray(out.enum) && out.enum.every((v: unknown) => !Array.isArray(v))) {
      const values = out.enum.filter((v: unknown) => v !== null);
      delete out.enum;
      out.items = isObj(out.items) ? { ...out.items, enum: values } : { enum: values };
    }
    if (Array.isArray(node.oneOf)) {
      const variants = node.oneOf.map((item: unknown, i: number) => this.convert(item, child(ptr, 'oneOf', i)));
      if (this.options.strictOneOf) out.oneOf = variants;
      else if (out.anyOf) out.allOf = [...(out.allOf ?? []), { anyOf: variants }];
      else out.anyOf = variants;
    }
    if (isObj(node.discriminator) && typeof node.discriminator.propertyName === 'string') {
      const branches = this.discriminatorBranches(node);
      if (branches.length > 0) out.allOf = [...(out.allOf ?? []), ...branches];
    }
    if (this.options.context === 'request' && Array.isArray(out.required) && isObj(node.properties)) {
      out.required = out.required.filter((name: string) => !isObj(node.properties[name]) || !deref(this.spec.doc, node.properties[name]).readOnly);
    }
    if (this.options.context === 'response' && Array.isArray(out.required) && isObj(node.properties)) {
      out.required = out.required.filter((name: string) => !isObj(node.properties[name]) || !deref(this.spec.doc, node.properties[name]).writeOnly);
    }
    if (node.nullable === true) return nullable(out);
    return out;
  }

  private discriminatorBranches(node: Obj): Obj[] {
    const prop = node.discriminator.propertyName as string;
    const variants: unknown[] = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : [];
    const mapping: Obj = isObj(node.discriminator.mapping) ? node.discriminator.mapping : {};
    const byRef = new Map<string, string[]>();
    for (const [value, target] of Object.entries(mapping)) {
      if (typeof target !== 'string') continue;
      const ref = target.startsWith('#') ? target : `#/components/schemas/${target}`;
      byRef.set(ref, [...(byRef.get(ref) ?? []), value]);
    }
    const branches: Obj[] = [];
    for (const variant of variants) {
      if (!isObj(variant) || typeof variant.$ref !== 'string') continue;
      const ref = variant.$ref as string;
      let values = byRef.get(ref);
      if (!values) {
        const own = deref(this.spec.doc, variant)?.properties?.[prop];
        const resolved = own ? deref(this.spec.doc, own) : undefined;
        if (resolved && typeof resolved.const === 'string') values = [resolved.const];
        else if (resolved && Array.isArray(resolved.enum)) values = resolved.enum.filter((v: unknown) => typeof v === 'string');
        else values = [ref.split('/').pop() ?? ref];
      }
      const target = this.convert(variant, ref);
      for (const value of values ?? []) {
        branches.push({ if: { properties: { [prop]: { const: value } }, required: [prop] }, then: target });
      }
    }
    return branches;
  }
}

function nullable(schema: Obj): Obj {
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'], ...(schema.enum ? { enum: withNull(schema.enum) } : {}) };
  if (Array.isArray(schema.type)) {
    return { ...schema, type: schema.type.includes('null') ? schema.type : [...schema.type, 'null'], ...(schema.enum ? { enum: withNull(schema.enum) } : {}) };
  }
  if (schema.enum) return { ...schema, enum: withNull(schema.enum) };
  return { anyOf: [schema, { type: 'null' }] };
}

function withNull(values: unknown[]): unknown[] {
  return values.includes(null) ? values : [...values, null];
}

export function stripContent(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripContent);
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (CONTENT_KEYWORDS.has(key)) continue;
    if (key === 'enum' || key === 'const' || key === 'required' || key === 'type' || key === 'dependentRequired') out[key] = value;
    else if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'dependentSchemas') {
      const map: Obj = {};
      for (const [name, sub] of Object.entries(value as Obj)) map[name] = stripContent(sub);
      out[key] = map;
    } else out[key] = stripContent(value);
  }
  return out;
}

export function schemaTypes(doc: Obj, schema: unknown, depth = 0): Set<string> {
  const types = new Set<string>();
  const node = deref(doc, schema);
  if (!isObj(node) || depth > 20) return types;
  if (typeof node.type === 'string') types.add(node.type);
  if (Array.isArray(node.type)) for (const t of node.type) types.add(t);
  if (node.nullable === true) types.add('null');
  if (types.size === 0) {
    if (isObj(node.properties) || node.additionalProperties !== undefined) types.add('object');
    if (node.items !== undefined) types.add('array');
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? 'number' : typeof value);
    }
    if (node.const !== undefined) types.add(node.const === null ? 'null' : typeof node.const);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(node[key])) continue;
    const sets = node[key].map((sub: unknown) => schemaTypes(doc, sub, depth + 1));
    if (key === 'allOf' && types.size > 0) continue;
    for (const set of sets) for (const t of set) types.add(t);
  }
  return types;
}
