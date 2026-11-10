import type { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { jsonType } from './generate.ts';
import { DEFS_ID, SchemaConverter, stripContent } from './schema.ts';
import { type Obj, type Spec, isObj } from './spec.ts';

type Ajv2020Class = typeof import('ajv/dist/2020.js').default;
const Ajv2020: Ajv2020Class = ((Ajv2020Module as unknown as { default?: Ajv2020Class }).default ?? Ajv2020Module) as Ajv2020Class;
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (ajv: unknown) => void;

export type Severity = 'error' | 'warning';

export interface Issue {
  location: string;
  code: string;
  message: string;
  severity: Severity;
}

export interface ValidatorOptions {
  strictOneOf: boolean;
  strict: boolean;
  onCompileError: (ptr: string, message: string) => void;
}

export interface CompileError {
  ptr: string;
  message: string;
}

const COMPOSITE = new Set(['anyOf', 'oneOf', 'allOf', 'if', 'then', 'else', 'discriminator']);
const NULL_SENSITIVE = new Set(['type', 'enum', 'const']);

type Compiled = { structural: ValidateFunction | null; full: ValidateFunction | null; error: string | null };

export class Validator {
  private readonly converter: SchemaConverter;
  private readonly converted = new Map<string, Obj | boolean>();
  private readonly compiled = new Map<string, Compiled>();
  private readonly options: ValidatorOptions;
  private structuralAjv: InstanceType<typeof Ajv2020> | null = null;
  private fullAjv: InstanceType<typeof Ajv2020> | null = null;
  private sealed = false;

  constructor(spec: Spec, options: Partial<ValidatorOptions> = {}) {
    this.options = { strictOneOf: false, strict: false, onCompileError: () => {}, ...options };
    this.converter = new SchemaConverter(spec, { strictOneOf: this.options.strictOneOf, context: 'request' });
  }

  register(schema: unknown, ptr: string): void {
    if (!this.converted.has(ptr)) this.converted.set(ptr, this.converter.convert(schema, ptr));
  }

  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    const defs = { $id: DEFS_ID, $defs: this.converter.defs };
    this.structuralAjv = makeAjv(false);
    this.fullAjv = makeAjv(true);
    this.structuralAjv.addSchema(stripContent(defs) as Obj);
    this.fullAjv.addSchema(defs);
  }

  private compile(ptr: string): Compiled {
    let entry = this.compiled.get(ptr);
    if (entry) return entry;
    this.seal();
    const schema = this.converted.get(ptr);
    entry = { structural: null, full: null, error: null };
    if (schema !== undefined && schema !== true) {
      const structural = safeCompile(this.structuralAjv!, stripContent(schema) as Obj | boolean);
      const full = safeCompile(this.fullAjv!, schema);
      entry.structural = structural.fn;
      entry.full = full.fn;
      entry.error = structural.error ?? full.error;
      if (entry.error !== null) this.options.onCompileError(ptr, entry.error);
    }
    this.compiled.set(ptr, entry);
    return entry;
  }

  compileAll(): CompileError[] {
    const failures: CompileError[] = [];
    for (const ptr of this.converted.keys()) {
      const { error } = this.compile(ptr);
      if (error !== null) failures.push({ ptr, message: error });
    }
    return failures;
  }

  check(ptr: string, value: unknown, location: string): Issue[] {
    const { structural, full } = this.compile(ptr);
    if (structural && !structural(value)) {
      const errors = leafErrors(structural.errors ?? []);
      const onlyNulls = errors.length > 0 && errors.every((e) => NULL_SENSITIVE.has(e.keyword) && e.data === null);
      const severity: Severity = onlyNulls && !this.options.strict ? 'warning' : 'error';
      return summarize(errors, location, severity, onlyNulls ? 'null' : 'structure');
    }
    if (full && !full(value)) {
      const errors = leafErrors(full.errors ?? []);
      return summarize(errors, location, this.options.strict ? 'error' : 'warning', 'content');
    }
    return [];
  }
}

function makeAjv(formats: boolean): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    verbose: true,
    logger: false,
    unicodeRegExp: false,
    validateFormats: formats,
    inlineRefs: false,
  });
  if (formats) {
    addFormats(ajv);
    for (const name of ['int32', 'int64', 'float', 'double', 'byte', 'binary', 'password']) {
      if (!ajv.formats[name]) ajv.addFormat(name, true);
    }
  }
  return ajv;
}

function safeCompile(ajv: InstanceType<typeof Ajv2020>, schema: Obj | boolean): { fn: ValidateFunction | null; error: string | null } {
  try {
    return { fn: ajv.compile(typeof schema === 'boolean' ? { allOf: [schema] } : schema), error: null };
  } catch (first) {
    try {
      return { fn: ajv.compile(stripPatterns(schema) as Obj), error: null };
    } catch {
      return { fn: null, error: (first as Error).message };
    }
  }
}

function stripPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPatterns);
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' && typeof value === 'string') continue;
    out[key] = key === 'enum' || key === 'const' ? value : stripPatterns(value);
  }
  return out;
}

function leafErrors(errors: ErrorObject[]): ErrorObject[] {
  const leaves = errors.filter((e) => !COMPOSITE.has(e.keyword));
  const picked = leaves.length > 0 ? leaves : errors;
  return picked.filter((e) => {
    if (e.keyword !== 'type' || (e.params as Obj).type !== 'null' || e.data === null) return true;
    return !picked.some((other) => other !== e && other.instancePath.startsWith(e.instancePath) && other.instancePath.length > e.instancePath.length);
  });
}

function describe(e: ErrorObject): { code: string; message: string; extra?: string } {
  const p = e.params as Obj;
  switch (e.keyword) {
    case 'type':
      return { code: 'type', message: `Should be ${Array.isArray(p.type) ? p.type.join(' or ') : p.type}, received ${jsonType(e.data)}` };
    case 'required':
      return { code: 'required', message: `Required property "${p.missingProperty}" is missing`, extra: String(p.missingProperty) };
    case 'enum':
      return { code: 'enum', message: `${JSON.stringify(e.data)} is not one of the enum values` };
    case 'const':
      return { code: 'const', message: `${JSON.stringify(e.data)} should equal the constant ${JSON.stringify(p.allowedValue)}` };
    case 'additionalProperties':
      return { code: 'additional-property', message: `Property "${p.additionalProperty}" is not declared in the schema`, extra: String(p.additionalProperty) };
    case 'unevaluatedProperties':
      return { code: 'additional-property', message: `Property "${p.unevaluatedProperty}" is not declared in the schema`, extra: String(p.unevaluatedProperty) };
    case 'format':
      return { code: 'format', message: `${JSON.stringify(e.data)} is not a valid ${p.format}` };
    case 'not':
      return { code: 'not', message: 'Matches a schema that it must not match' };
    case 'false schema':
      return { code: 'not-allowed', message: 'Nothing is allowed here' };
    default:
      return { code: e.keyword, message: e.message ?? `does not satisfy ${e.keyword}` };
  }
}

function summarize(errors: ErrorObject[], location: string, severity: Severity, kind: string): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const e of errors) {
    const { code, message, extra } = describe(e);
    const segments = e.instancePath.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (extra) segments.push(extra);
    const at = [location, ...segments].filter((s) => s !== '').join('.');
    const key = `${at}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ location: at, code: `${kind}.${code}`, message, severity });
    if (issues.length >= 10) break;
  }
  return issues;
}
