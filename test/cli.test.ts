import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/main.ts';
import { loadSpec } from '../src/spec.ts';

test('bad flag values are usage errors', () => {
  assert.throws(() => parseArgs(['spec.yaml', '-p']), /-p needs a value/);
  assert.throws(() => parseArgs(['spec.yaml', '--port=']), /invalid value for --port/);
  assert.throws(() => parseArgs(['spec.yaml', '--log-level=full']), /invalid value for --log-level/);
  assert.throws(() => parseArgs(['spec.yaml', '--no-color']), /unknown option --no-color/);
  assert.equal(parseArgs(['spec.yaml', '--generator-array-max=4']).options.generator?.arrayMax, 4);
});

test('flags parse', () => {
  const parsed = parseArgs([
    '--host',
    '127.0.0.1',
    '-p',
    '4010',
    '--validator-query-array-format=comma',
    '--validator-form-array-format=comma',
    '--validator-query-object-format=dots',
    '--validator-form-object-format=dots',
    '--reject-on-sdk-error=false',
    '--log-level=silent',
    'openapi.json',
  ]);
  assert.equal(parsed.port, 4010);
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.spec, 'openapi.json');
  assert.deepEqual(parsed.options.query, { array: 'comma', object: 'dots' });
  assert.deepEqual(parsed.options.form, { array: 'comma', object: 'dots' });
  assert.equal(parsed.options.reject, false);
  assert.equal(parsed.options.logLevel, 'silent');
  assert.deepEqual(parseArgs(['--validator-query-array-format', 'auto', 'a.yaml']).options.query, { array: null, object: null });
  assert.throws(() => parseArgs(['--validator-query-array-format=weird', 'a.yaml']), /invalid value/);
  assert.throws(() => parseArgs(['--bogus', 'a.yaml']), /unknown option/);
  assert.equal(parseArgs(['validate', 'a.yaml']).command, 'validate');
  assert.equal(parseArgs(['--version']).command, 'version');
});

test('YAML specs with external refs load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legible-mock-'));
  writeFileSync(join(dir, 'pet.yaml'), 'type: object\nproperties:\n  name:\n    type: string\n');
  writeFileSync(
    join(dir, 'api.yaml'),
    `openapi: 3.0.0
info: { title: Ext, version: '1' }
paths:
  /pets:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: './pet.yaml' }
`,
  );
  const spec = await loadSpec(join(dir, 'api.yaml'));
  assert.equal(spec.version, '3.0');
  const ref = spec.doc.paths['/pets'].get.responses['200'].content['application/json'].schema.$ref;
  assert.match(ref, /^#\/x-mock-external\//);
  await assert.rejects(loadSpec(join(dir, 'missing.yaml')));
});

test('the CLI starts, serves and reports fatal errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legible-mock-'));
  const file = join(dir, 'api.json');
  writeFileSync(file, JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: { '/ping': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { example: { pong: true } } } } } } } } }));
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [cli, '-p', String(port), '--quiet', file], { stdio: 'pipe' });
  try {
    let body: unknown = null;
    for (let i = 0; i < 100 && body === null; i++) {
      try {
        body = await (await fetch(`http://127.0.0.1:${port}/ping`)).json();
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.deepEqual(body, { pong: true });
  } finally {
    child.kill();
  }
  const bad = spawn(process.execPath, [cli, join(dir, 'nope.json')], { stdio: 'pipe' });
  let stderr = '';
  bad.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => bad.on('exit', r));
  assert.equal(code, 1);
  assert.match(stderr, /^fatal: /);
});
