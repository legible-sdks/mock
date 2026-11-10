import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { validateBody } from './body.ts';
import { ARRAY_FORMATS, type Formats, OBJECT_FORMATS } from './form.ts';
import type { GenerateOptions } from './generate.ts';
import { type ParamOverrides, validateParameters } from './params.ts';
import { encodeBody, parsePrefer, planResponse, streamEvents } from './respond.ts';
import { type Operation, Router } from './router.ts';
import type { Spec } from './spec.ts';
import { type Issue, Validator } from './validator.ts';

export const VERSION = '0.1.0';

export type LogLevel = 'silent' | 'summary' | 'details';

export interface MockOptions {
  query: ParamOverrides;
  form: ParamOverrides;
  reject: boolean;
  strict: boolean;
  strictOneOf: boolean;
  logLevel: LogLevel;
  generator: Partial<GenerateOptions>;
  streamCount: number;
  streamIntervalMs: number;
  log: (line: string) => void;
}

export const DEFAULT_OPTIONS: MockOptions = {
  query: { array: null, object: null },
  form: { array: null, object: null },
  reject: true,
  strict: false,
  strictOneOf: false,
  logLevel: 'summary',
  generator: {},
  streamCount: 5,
  streamIntervalMs: 0,
  log: (line) => process.stdout.write(`${line}\n`),
};

const HEALTH_PATH = '/_x-mock/health';
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_STREAM_EVENTS = 10000;
const MAX_LISTED_PATHS = 5;

export interface Mock {
  router: Router;
  validator: Validator;
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  validate: (method: string, url: string, headers: Record<string, string | string[] | undefined>, body: Buffer) => Validation;
}

export interface Validation {
  status: number;
  operation: Operation | null;
  issues: Issue[];
  params: Record<string, string>;
}

function formatsFor(overrides: ParamOverrides, header: (name: string) => string | undefined, prefix: string): ParamOverrides {
  const array = header(`x-mock-${prefix}-array-format`);
  const object = header(`x-mock-${prefix}-object-format`);
  const validArray = array !== undefined && array !== 'auto' && (ARRAY_FORMATS as readonly string[]).includes(array);
  const validObject = object !== undefined && object !== 'auto' && (OBJECT_FORMATS as readonly string[]).includes(object);
  return {
    array: validArray ? (array as Formats['array']) : overrides.array,
    object: validObject ? (object as Formats['object']) : overrides.object,
  };
}

export function createMock(spec: Spec, partial: Partial<MockOptions> = {}): Mock {
  const options: MockOptions = { ...DEFAULT_OPTIONS, ...partial };
  const router = new Router(spec);
  const validator = new Validator(spec, {
    strict: options.strict,
    strictOneOf: options.strictOneOf,
    onCompileError: (ptr, message) => {
      if (options.logLevel !== 'silent') options.log(`warning: the schema at ${ptr} could not be compiled, so values it describes are not validated: ${message}`);
    },
  });
  for (const op of router.operations()) {
    for (const param of op.params) if (param.schema !== undefined) validator.register(param.schema, param.ptr);
    for (const media of op.body?.content ?? []) if (media.schema !== undefined) validator.register(media.schema, media.ptr);
  }
  validator.seal();
  const doc = spec.doc;

  const validate = (method: string, url: string, headers: Record<string, string | string[] | undefined>, body: Buffer): Validation => {
    const parsed = new URL(url.startsWith('//') ? `/.${url}` : url, 'http://mock.local');
    const match = router.match(method, parsed.pathname);
    if (match.kind === 'none') {
      return {
        status: 404,
        operation: null,
        params: {},
        issues: [{ location: parsed.pathname, code: 'route', message: `No path in the spec matches ${parsed.pathname}`, severity: 'error' }],
      };
    }
    if (match.kind === 'method') {
      return {
        status: 405,
        operation: null,
        params: {},
        issues: [{ location: match.path, code: 'method', message: `${match.path} has no ${method} operation`, severity: 'error' }],
      };
    }
    const header = (name: string): string | undefined => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const op = match.operation;
    const label = `Operation ${op.method} ${op.path}`;
    const issues = [
      ...validateParameters(
        { doc, validator, overrides: formatsFor(options.query, header, 'query'), strict: options.strict },
        op.params,
        { query: [...parsed.searchParams], path: match.params, headers },
      ),
      ...validateBody(
        { doc, validator, form: resolveForm(formatsFor(options.form, header, 'form')), strict: options.strict },
        op.body,
        header('content-type'),
        body,
        label,
      ),
    ];
    return { status: 200, operation: op, issues, params: match.params };
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    const started = Date.now();
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (tooLarge) {
        sendJson(res, 413, { error: `The request body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB` }, { connection: 'close' });
        logLine(req, 413, started, []);
        return;
      }
      try {
        respond(req, res, Buffer.concat(chunks), started);
      } catch (error) {
        sendJson(res, 500, { error: 'Mock server error', message: (error as Error).message });
        logLine(req, 500, started, [{ location: '', code: 'internal', message: (error as Error).message, severity: 'error' }]);
      }
    });
  };

  const logLine = (req: IncomingMessage, status: number, started: number, issues: Issue[]): void => {
    if (options.logLevel === 'silent') return;
    const time = new Date().toISOString().slice(11, 23);
    options.log(`${time} ${status} ${req.method} ${req.url} ${Date.now() - started}ms`);
    if (options.logLevel === 'summary') {
      const first = issues[0];
      if (first) options.log(`  ${first.severity} ${first.location}: ${first.message}${issues.length > 1 ? `, ${issues.length - 1} more` : ''}`);
      return;
    }
    for (const issue of issues) options.log(`  ${issue.severity} ${issue.location} [${issue.code}]: ${issue.message}`);
  };

  const respond = (req: IncomingMessage, res: ServerResponse, body: Buffer, started: number): void => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    if (path === HEALTH_PATH) {
      const info = isObjInfo(doc.info);
      sendJson(res, 200, { ok: true, server: 'legible-mock', version: VERSION, spec: { title: info.title, version: info.version } });
      return;
    }
    const result = validate(method, url, req.headers, body);
    const errors = result.issues.filter((i) => i.severity === 'error');
    const headerValue = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const rejectHeader = headerValue('x-mock-reject-on-error');
    const reject = rejectHeader === undefined ? options.reject : rejectHeader === 'true';
    const diag: Record<string, string> = {
      'x-mock-request-valid': String(errors.length === 0),
      'x-mock-error-count': String(result.issues.length),
    };
    result.issues.slice(0, 5).forEach((issue, i) => {
      diag[`x-mock-error-${i + 1}-code`] = issue.code;
      diag[`x-mock-error-${i + 1}-path`] = headerSafe(issue.location);
      diag[`x-mock-error-${i + 1}-message`] = headerSafe(issue.message);
    });
    if (!result.operation) {
      const issue = result.issues[0];
      let suggestion: string;
      if (result.status === 404) {
        const paths = router.routes.map((r) => r.path).sort();
        const rest = paths.length - MAX_LISTED_PATHS;
        suggestion = `Spec paths: ${paths.slice(0, MAX_LISTED_PATHS).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
      } else {
        const allowed = allowedMethods(router, method, path);
        suggestion = `Operations on this path: ${allowed.join(', ')}`;
        diag.allow = allowed.join(', ');
      }
      sendJson(res, result.status, { error: issue?.message ?? 'Not found', suggestion }, diag);
      logLine(req, result.status, started, result.issues);
      return;
    }
    diag['x-mock-matched-path'] = result.operation.path;
    if (errors.length > 0 && reject) {
      sendJson(res, 400, { error: 'The request does not match the spec', issues: result.issues }, diag);
      logLine(req, 400, started, result.issues);
      return;
    }
    const prefer = parsePrefer(req.headers.prefer);
    const forced = headerValue('x-mock-code');
    if (forced) prefer.code = forced;
    const gen = { ...options.generator, ...generatorHeaders(headerValue) };
    const plan = planResponse(doc, result.operation.node, prefer, headerValue('accept'), gen);
    if (!plan.ok) {
      sendJson(res, plan.status, { error: plan.message }, diag);
      logLine(req, plan.status, started, [...result.issues, { location: 'header.prefer', code: 'prefer', message: plan.message, severity: 'error' }]);
      return;
    }
    const planned = plan.response;
    const headers: Record<string, string> = { ...planned.headers, ...diag, 'x-mock-example-source': planned.source };
    if (!planned.hasBody || method === 'HEAD') {
      if (planned.contentType) headers['content-type'] = planned.contentType;
      res.writeHead(planned.status, headers);
      res.end();
      logLine(req, planned.status, started, result.issues);
      return;
    }
    const contentType = planned.contentType as string;
    if (planned.stream) {
      const count = Number(headerValue('x-mock-stream-count') ?? options.streamCount);
      const interval = Number(headerValue('x-mock-stream-interval-ms') ?? options.streamIntervalMs);
      headers['content-type'] = contentType;
      headers['cache-control'] = 'no-cache';
      headers['x-mock-streaming'] = 'true';
      res.writeHead(planned.status, headers);
      if (planned.stream === 'sse' && typeof planned.body === 'string') {
        res.end(planned.body.endsWith('\n') ? planned.body : `${planned.body}\n\n`);
      } else {
        const events = streamEvents(planned.body, planned.stream, Math.min(MAX_STREAM_EVENTS, Number.isFinite(count) && count >= 0 ? count : options.streamCount));
        const lines = events.map((event) => {
          if (planned.stream === 'ndjson') return `${event.data}\n`;
          let text = '';
          if (event.id !== null) text += `id: ${event.id}\n`;
          if (event.event !== null) text += `event: ${event.event}\n`;
          for (const line of event.data.split('\n')) text += `data: ${line}\n`;
          return `${text}\n`;
        });
        writeSpaced(res, lines, Number.isFinite(interval) && interval > 0 ? interval : 0);
      }
      logLine(req, planned.status, started, result.issues);
      return;
    }
    const payload = encodeBody(contentType, planned.body);
    headers['content-type'] = contentType;
    headers['content-length'] = String(payload.length);
    res.writeHead(planned.status, headers);
    res.end(payload);
    logLine(req, planned.status, started, result.issues);
  };

  return { router, validator, handle, validate };
}

function allowedMethods(router: Router, method: string, path: string): string[] {
  const match = router.match(method, path);
  return match.kind === 'method' ? match.allowed : [];
}

function resolveForm(overrides: ParamOverrides): Formats {
  return { array: overrides.array ?? 'repeat', object: overrides.object ?? 'brackets' };
}

function generatorHeaders(header: (name: string) => string | undefined): Partial<GenerateOptions> {
  const out: Partial<GenerateOptions> = {};
  const size = header('x-mock-array-size');
  const min = header('x-mock-array-min');
  const max = header('x-mock-array-max');
  if (size !== undefined && Number.isFinite(Number(size))) out.arrayMin = out.arrayMax = Number(size);
  if (min !== undefined && Number.isFinite(Number(min))) out.arrayMin = Number(min);
  if (max !== undefined && Number.isFinite(Number(max))) out.arrayMax = Number(max);
  return out;
}

function writeSpaced(res: ServerResponse, lines: string[], interval: number): void {
  if (interval === 0) {
    res.end(lines.join(''));
    return;
  }
  let i = 0;
  let timer: NodeJS.Timeout | null = null;
  res.once('close', () => {
    if (timer !== null) clearTimeout(timer);
  });
  const tick = (): void => {
    timer = null;
    if (i >= lines.length || res.destroyed) {
      res.end();
      return;
    }
    res.write(lines[i++]);
    timer = setTimeout(tick, interval);
  };
  tick();
}

function isObjInfo(info: unknown): { title?: string; version?: string } {
  return typeof info === 'object' && info !== null ? (info as { title?: string; version?: string }) : {};
}

function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': String(payload.length) });
  res.end(payload);
}

export function listen(mock: Mock, port: number, host: string): Promise<Server> {
  const server = createServer(mock.handle);
  server.keepAliveTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
