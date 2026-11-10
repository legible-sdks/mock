import { readRequestBody, type RequestBodySpec } from './body.ts';
import { type Parameter, readParameter } from './params.ts';
import { HTTP_METHODS, type Obj, type Spec, child, escapeRegExp, isObj, resolveRef } from './spec.ts';

export interface Operation {
  method: string;
  path: string;
  ptr: string;
  node: Obj;
  params: Parameter[];
  body: RequestBodySpec | null;
}

interface Segment {
  literal: string | null;
  regex: RegExp | null;
  names: string[];
}

interface Route {
  path: string;
  segments: Segment[];
  literals: number;
  operations: Map<string, Operation>;
}

export type Match =
  | { kind: 'ok'; operation: Operation; params: Record<string, string> }
  | { kind: 'method'; path: string; allowed: string[] }
  | { kind: 'none' };

function compileSegment(text: string): Segment {
  if (!text.includes('{')) return { literal: text, regex: null, names: [] };
  const names: string[] = [];
  let source = '^';
  let last = 0;
  for (const match of text.matchAll(/\{([^}]+)\}/g)) {
    source += escapeRegExp(text.slice(last, match.index));
    names.push(match[1] as string);
    source += '(.+?)';
    last = (match.index ?? 0) + match[0].length;
  }
  source += escapeRegExp(text.slice(last)) + '$';
  return { literal: null, regex: new RegExp(source), names };
}

function splitPath(path: string): string[] {
  return path.split('/').slice(1);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export class Router {
  readonly routes: Route[] = [];
  readonly basePaths: string[] = [];

  constructor(spec: Spec) {
    const doc = spec.doc;
    const paths = isObj(doc.paths) ? doc.paths : {};
    for (const [path, rawItem] of Object.entries(paths)) {
      const { node: item, ptr: itemPtr } = resolveRef(doc, rawItem, child('#/paths', path));
      if (!isObj(item)) continue;
      const shared = Array.isArray(item.parameters) ? item.parameters.map((p: unknown, i: number) => ({ p, ptr: child(itemPtr, 'parameters', i) })) : [];
      const operations = new Map<string, Operation>();
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isObj(op)) continue;
        const opPtr = child(itemPtr, method);
        const own = Array.isArray(op.parameters) ? op.parameters.map((p: unknown, i: number) => ({ p, ptr: child(opPtr, 'parameters', i) })) : [];
        const byKey = new Map<string, Parameter>();
        for (const { p, ptr } of [...shared, ...own]) {
          const located = resolveRef(doc, p, ptr);
          if (!isObj(located.node)) continue;
          const param = readParameter(located.node, located.ptr);
          if (param) byKey.set(`${param.in}:${param.in === 'header' ? param.name.toLowerCase() : param.name}`, param);
        }
        const body = op.requestBody === undefined ? null : resolveRef(doc, op.requestBody, child(opPtr, 'requestBody'));
        operations.set(method.toUpperCase(), {
          method: method.toUpperCase(),
          path,
          ptr: opPtr,
          node: op,
          params: [...byKey.values()],
          body: body ? readRequestBody(body.node, body.ptr) : null,
        });
      }
      const segments = splitPath(path).map(compileSegment);
      this.routes.push({ path, segments, literals: segments.filter((s) => s.literal !== null).length, operations });
    }
    this.routes.sort((a, b) => b.literals - a.literals || literalOrder(b) - literalOrder(a) || partialLiterals(b) - partialLiterals(a));
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    for (const server of servers) {
      if (!isObj(server) || typeof server.url !== 'string') continue;
      let url = server.url.replace(/\{[^}]+\}/g, (m: string) => {
        const name = m.slice(1, -1);
        const variable = isObj(server.variables) ? server.variables[name] : undefined;
        return isObj(variable) && variable.default !== undefined ? String(variable.default) : 'x';
      });
      try {
        url = new URL(url, 'http://localhost').pathname;
      } catch {
        continue;
      }
      const base = url.replace(/\/+$/, '');
      if (base && !this.basePaths.includes(base)) this.basePaths.push(base);
    }
  }

  operations(): Operation[] {
    return this.routes.flatMap((r) => [...r.operations.values()]);
  }

  match(method: string, rawPath: string): Match {
    const first = this.matchPath(method, rawPath);
    if (first.kind !== 'none') return first;
    for (const base of this.basePaths) {
      if (rawPath === base || rawPath.startsWith(`${base}/`)) {
        const stripped = this.matchPath(method, rawPath.slice(base.length) || '/');
        if (stripped.kind !== 'none') return stripped;
      }
    }
    if (rawPath.length > 1 && rawPath.endsWith('/')) return this.matchPath(method, rawPath.replace(/\/+$/, ''));
    return first;
  }

  private matchPath(method: string, rawPath: string): Match {
    const parts = splitPath(rawPath);
    let methodMiss: Route | null = null;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      const op = route.operations.get(method) ?? (method === 'HEAD' ? route.operations.get('GET') : undefined);
      if (op) return { kind: 'ok', operation: op, params };
      methodMiss ??= route;
    }
    if (methodMiss) return { kind: 'method', path: methodMiss.path, allowed: [...methodMiss.operations.keys()] };
    return { kind: 'none' };
  }
}

function partialLiterals(route: Route): number {
  let chars = 0;
  for (const segment of route.segments) if (segment.literal === null && segment.regex) chars += segment.regex.source.replace(/\(\.\+\?\)/g, '').replace(/[\^$\\]/g, '').length;
  return chars;
}

function literalOrder(route: Route): number {
  let score = 0;
  for (const segment of route.segments) score = score * 2 + (segment.literal !== null ? 1 : 0);
  return score;
}

function matchSegments(segments: Segment[], parts: string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as Segment;
    const part = parts[i] as string;
    if (segment.literal !== null) {
      if (segment.literal !== part && segment.literal !== decode(part)) return null;
      continue;
    }
    if (part === '') return null;
    const match = segment.regex?.exec(part);
    if (!match) return null;
    segment.names.forEach((name, j) => {
      params[name] = decode(match[j + 1] as string);
    });
  }
  return params;
}
