import { ARRAY_FORMATS, type ArrayFormat, type Formats, OBJECT_FORMATS, type ObjectFormat } from './form.ts';
import { DEFAULT_OPTIONS, type LogLevel, type MockOptions, VERSION, createMock, listen } from './server.ts';
import { loadSpec } from './spec.ts';

const HELP = `legible-mock ${VERSION}

Usage: legible-mock [validate] [options] <spec>

<spec> is an OpenAPI 3.0 or 3.1 file (YAML or JSON) or an http(s) URL.
External $refs are loaded relative to it. "validate" loads the spec,
compiles every schema and exits without serving.

Options:
  -p, --port <port>                       Port (default: servers[0] port or 4010)
  --host <host>                           Host to bind (default: 127.0.0.1)
  -q, --quiet                             No request logging
  --log-level <silent|summary|details>    Request log detail (default: summary)
  --reject-on-sdk-error[=true|false]      Answer 400 to invalid requests (default: true)
  --validator-strict                      Also reject format, range, length, null and unknown query parameters
  --validator-strict-oneof                oneOf requires exactly one matching variant
  --validator-query-array-format=<fmt>    auto | repeat | comma | space | pipe | brackets | indices
  --validator-query-object-format=<fmt>   auto | flat | flat-comma | brackets | dots
  --validator-form-array-format=<fmt>     Same as query, for urlencoded bodies
  --validator-form-object-format=<fmt>    Same as query, for urlencoded bodies
  --generator-array-size=<n>              Items in generated arrays (default: 1)
  --generator-array-min=<n>               Lower bound for generated arrays
  --generator-array-max=<n>               Upper bound for generated arrays
  --stream-count=<n>                      Events per generated stream (default: 5)
  --stream-interval-ms=<n>                Delay between streamed events (default: 0)
  --version                               Print the version
  -h, --help                              Print this help

Request headers:
  Prefer: code=429                        Answer with the spec response for that status
  Prefer: example=name                    Pick a named example
  X-Mock-Code: 429                        Same as Prefer: code
  X-Mock-Reject-On-Error: false           Let an invalid request through
  X-Mock-Array-Size, -Min, -Max           Generated array length for this request
  X-Mock-Query-Array-Format               Query formats for this request
  X-Mock-Query-Object-Format
  X-Mock-Form-Array-Format                Form formats for this request
  X-Mock-Form-Object-Format
  X-Mock-Stream-Count                     Events in a generated stream (max 10000)
  X-Mock-Stream-Interval-Ms               Delay between events

Response headers:
  X-Mock-Request-Valid                    true or false
  X-Mock-Error-Count                      Number of issues found
  X-Mock-Error-<n>-Code, -Path, -Message  The first five issues
  X-Mock-Matched-Path                     Spec path the request matched
  X-Mock-Example-Source                   example, generated or none
  X-Mock-Streaming                        true for streamed responses

GET /_x-mock/health answers 200 once the server is ready.
`;

class UsageError extends Error {}

interface Parsed {
  command: 'serve' | 'validate' | 'help' | 'version';
  spec: string | null;
  port: number | null;
  host: string;
  options: Partial<MockOptions>;
}

const VALUE_FLAGS = new Set([
  'port',
  'host',
  'log-level',
  'validator-query-array-format',
  'validator-query-object-format',
  'validator-form-array-format',
  'validator-form-object-format',
  'generator-array-size',
  'generator-array-min',
  'generator-array-max',
  'stream-count',
  'stream-interval-ms',
]);

function arrayFormat(value: string, flag: string): Formats['array'] | null {
  if (!(ARRAY_FORMATS as readonly string[]).includes(value)) throw new UsageError(`invalid value for --${flag}: ${value}`);
  return value === 'auto' ? null : (value as Exclude<ArrayFormat, 'auto'>);
}

function objectFormat(value: string, flag: string): Formats['object'] | null {
  if (!(OBJECT_FORMATS as readonly string[]).includes(value)) throw new UsageError(`invalid value for --${flag}: ${value}`);
  return value === 'auto' ? null : (value as Exclude<ObjectFormat, 'auto'>);
}

function integer(value: string, flag: string): number {
  const n = value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`invalid value for --${flag}: ${value}`);
  return n;
}

function bool(value: string | undefined, flag: string): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new UsageError(`invalid value for --${flag}: ${value}`);
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { command: 'serve', spec: null, port: null, host: '127.0.0.1', options: {} };
  const query = { ...DEFAULT_OPTIONS.query };
  const form = { ...DEFAULT_OPTIONS.form };
  const generator: MockOptions['generator'] = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') return { ...out, command: 'help' };
    if (arg === '--version') return { ...out, command: 'version' };
    if (arg === '-q' || arg === '--quiet') {
      out.options.logLevel = 'silent';
      continue;
    }
    if (arg === '-p') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('-p needs a value');
      out.port = integer(value, 'port');
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (VALUE_FLAGS.has(name) && value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
    }
    switch (name) {
      case 'port':
        out.port = integer(value as string, name);
        break;
      case 'host':
        out.host = value as string;
        break;
      case 'log-level': {
        if (value !== 'silent' && value !== 'summary' && value !== 'details') throw new UsageError(`invalid value for --log-level: ${value}`);
        out.options.logLevel = value as LogLevel;
        break;
      }
      case 'reject-on-sdk-error':
        out.options.reject = bool(value, name);
        break;
      case 'validator-strict':
        out.options.strict = bool(value, name);
        break;
      case 'validator-strict-oneof':
        out.options.strictOneOf = bool(value, name);
        break;
      case 'validator-query-array-format':
        query.array = arrayFormat(value as string, name);
        break;
      case 'validator-query-object-format':
        query.object = objectFormat(value as string, name);
        break;
      case 'validator-form-array-format':
        form.array = arrayFormat(value as string, name);
        break;
      case 'validator-form-object-format':
        form.object = objectFormat(value as string, name);
        break;
      case 'generator-array-size':
        generator.arrayMin = generator.arrayMax = integer(value as string, name);
        break;
      case 'generator-array-min':
        generator.arrayMin = integer(value as string, name);
        break;
      case 'generator-array-max':
        generator.arrayMax = integer(value as string, name);
        break;
      case 'stream-count':
        out.options.streamCount = integer(value as string, name);
        break;
      case 'stream-interval-ms':
        out.options.streamIntervalMs = integer(value as string, name);
        break;
      default:
        throw new UsageError(`unknown option --${name}`);
    }
  }
  if (positionals[0] === 'validate') {
    out.command = 'validate';
    positionals.shift();
  }
  if (positionals.length > 1) throw new UsageError(`expected one spec file, got: ${positionals.join(' ')}`);
  out.spec = positionals[0] ?? null;
  out.options.query = query;
  out.options.form = form;
  out.options.generator = generator;
  return out;
}

function specPort(doc: Record<string, unknown>): number | null {
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const first = servers[0] as { url?: unknown } | undefined;
  if (!first || typeof first.url !== 'string') return null;
  try {
    const url = new URL(first.url);
    return url.port ? Number(url.port) : null;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`fatal: ${error.message}\n\n${HELP}`);
      return 2;
    }
    throw error;
  }
  if (parsed.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!parsed.spec) {
    process.stderr.write(`fatal: missing spec file\n\n${HELP}`);
    return 2;
  }
  const started = Date.now();
  let mock;
  let spec;
  try {
    spec = await loadSpec(parsed.spec);
    mock = createMock(spec, parsed.options);
  } catch (error) {
    process.stderr.write(`fatal: could not load ${parsed.spec}: ${(error as Error).message}\n`);
    return 1;
  }
  const count = mock.router.operations().length;
  const title = typeof spec.doc.info?.title === 'string' ? spec.doc.info.title : 'API';
  if (parsed.command === 'validate') {
    const failures = mock.validator.compileAll();
    for (const failure of failures) process.stderr.write(`schema ${failure.ptr}: ${failure.message}\n`);
    process.stdout.write(`${title}: ${count} operations, ${failures.length} schemas that cannot be validated (${Date.now() - started}ms)\n`);
    return failures.length === 0 ? 0 : 1;
  }
  const port = parsed.port ?? specPort(spec.doc) ?? 4010;
  let server;
  try {
    server = await listen(mock, port, parsed.host);
  } catch (error) {
    process.stderr.write(`fatal: could not listen on ${parsed.host}:${port}: ${(error as Error).message}\n`);
    return 1;
  }
  if (parsed.options.logLevel !== 'silent') {
    process.stdout.write(`legible-mock ${VERSION}: ${title}, ${count} operations (${Date.now() - started}ms)\nListening on http://${parsed.host}:${port}\n`);
  }
  const stop = (): void => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return -1;
}
