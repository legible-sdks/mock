import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type Obj = Record<string, any>;

export interface Spec {
  doc: Obj;
  version: '3.0' | '3.1';
  source: string;
}

export interface Located {
  node: any;
  ptr: string;
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function child(ptr: string, ...segments: Array<string | number>): string {
  return ptr + segments.map((s) => '/' + escapePointer(String(s))).join('');
}

export function getPointer(doc: unknown, ptr: string): unknown {
  const raw = ptr.startsWith('#') ? ptr.slice(1) : ptr;
  if (raw === '' || raw === '/') return raw === '' ? doc : (doc as Obj)?.[''];
  let node: any = doc;
  for (const part of raw.split('/').slice(1)) {
    const key = unescapePointer(decodeURIComponent(part));
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

export function resolveRef(doc: Obj, node: any, ptr = ''): Located {
  let current = node;
  let at = ptr;
  const seen = new Set<string>();
  while (isObj(current) && typeof current.$ref === 'string' && current.$ref.startsWith('#')) {
    const ref = current.$ref as string;
    if (seen.has(ref)) break;
    seen.add(ref);
    const target = getPointer(doc, ref);
    if (target === undefined) break;
    current = target;
    at = ref;
  }
  return { node: current, ptr: at };
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deref(doc: Obj, node: any): any {
  return resolveRef(doc, node).node;
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function readSource(source: string): Promise<string> {
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`could not fetch ${source}: HTTP ${response.status}`);
    return await response.text();
  }
  return await readFile(source, 'utf8');
}

export function parseDocument(text: string, source = 'spec'): Obj {
  const trimmed = text.trimStart();
  let parsed: unknown;
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = parseYaml(text, { maxAliasCount: 10000 });
    }
  } else {
    parsed = parseYaml(text, { maxAliasCount: 10000 });
  }
  if (!isObj(parsed)) throw new Error(`${source} is not an OpenAPI document`);
  return parsed;
}

function resolveSource(base: string, relative: string): string {
  if (isUrl(relative)) return relative;
  if (isUrl(base)) return new URL(relative, base).toString();
  return resolvePath(dirname(base), relative);
}

async function bundleExternal(doc: Obj, source: string): Promise<void> {
  const cache = new Map<string, Obj>();
  const placed = new Map<string, string>();
  const store: Obj = {};
  let count = 0;

  const load = async (file: string): Promise<Obj> => {
    let loaded = cache.get(file);
    if (!loaded) {
      loaded = parseDocument(await readSource(file), file);
      cache.set(file, loaded);
    }
    return loaded;
  };

  const visit = async (node: unknown, base: string, root: Obj): Promise<void> => {
    if (Array.isArray(node)) {
      for (const item of node) await visit(item, base, root);
      return;
    }
    if (!isObj(node)) return;
    if (typeof node.$ref === 'string') {
      const ref = node.$ref as string;
      if (!ref.startsWith('#') || root !== doc) {
        const hash = ref.indexOf('#');
        const filePart = hash === -1 ? ref : ref.slice(0, hash);
        const pointer = hash === -1 ? '' : ref.slice(hash + 1);
        const file = filePart === '' ? base : resolveSource(base, filePart);
        const key = `${file}#${pointer}`;
        let target = file === source ? `#${pointer}` : placed.get(key);
        if (!target) {
          const name = `ext${count++}`;
          target = `#/x-mock-external/${name}`;
          placed.set(key, target);
          const external = await load(file);
          const value = structuredClone(getPointer(external, pointer));
          if (value === undefined) throw new Error(`unresolved $ref ${ref} (from ${base})`);
          store[name] = value;
          await visit(value, file, external);
        }
        node.$ref = target;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== '$ref') await visit(value, base, root);
    }
  };

  await visit(doc, source, doc);
  if (count > 0) doc['x-mock-external'] = store;
}

function hasExternalRefs(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasExternalRefs);
  if (!isObj(node)) return false;
  if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) return true;
  return Object.values(node).some(hasExternalRefs);
}

export function specFromDocument(doc: Obj, source = 'spec'): Spec {
  const declared = String(doc.openapi ?? doc.swagger ?? '');
  if (declared.startsWith('2')) throw new Error('Swagger 2.0 is not supported, convert the document to OpenAPI 3');
  if (!declared.startsWith('3')) throw new Error(`${source} has no openapi version field`);
  return { doc, version: declared.startsWith('3.0') ? '3.0' : '3.1', source };
}

export async function loadSpec(source: string): Promise<Spec> {
  const location = isUrl(source) ? source : resolvePath(source);
  const doc = parseDocument(await readSource(location), source);
  if (hasExternalRefs(doc)) await bundleExternal(doc, location);
  return specFromDocument(doc, source);
}
