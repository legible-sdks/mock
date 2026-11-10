import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { conforms, generate } from '../src/generate.ts';
import { concreteType, encodeBody, parsePrefer, planResponse } from '../src/respond.ts';
import { listen } from '../src/server.ts';
import { PETS, petsMock } from './fixture.ts';
import { createMock } from '../src/server.ts';
import { specFromDocument } from '../src/spec.ts';

let base = '';
let close: () => void = () => {};

before(async () => {
  const server = await listen(petsMock({ query: { array: 'comma', object: 'brackets' } }), 0, '127.0.0.1');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => close());

test('health endpoints answer', async () => {
  for (const path of ['/_x-mock/health']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).ok, true);
  }
});

test('unknown routes answer 404 with error and suggestion', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  const body = ((await res.json()) as any);
  assert.equal(body.error, 'No path in the spec matches /nope');
  assert.match(body.suggestion, /^Spec paths: /);
  assert.match(body.suggestion, / and 3 more$/);
  const method = await fetch(`${base}/pets`, { method: 'PUT' });
  assert.equal(method.status, 405);
  assert.match(((await method.json()) as any).suggestion, /GET, POST/);
  assert.equal(method.headers.get('allow'), 'GET, POST');
});

test('invalid requests are rejected with 400 unless the client opts out', async () => {
  const res = await fetch(`${base}/pets?limit=abc`);
  assert.equal(res.status, 400);
  const body = ((await res.json()) as any);
  assert.equal(body.error, 'The request does not match the spec');
  assert.equal(body.issues[0].location, 'query.limit');
  assert.equal(res.headers.get('x-mock-request-valid'), 'false');
  const through = await fetch(`${base}/pets?limit=abc`, { headers: { 'x-mock-reject-on-error': 'false' } });
  assert.equal(through.status, 200);
});

test('responses come from schemas with generated headers', async () => {
  const res = await fetch(`${base}/pets`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total'), '3');
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = ((await res.json()) as any);
  assert.equal(body.length, 1);
  assert.deepEqual(Object.keys(body[0]).sort(), ['born', 'id', 'kind', 'name', 'owner']);
  assert.equal(body[0].kind, 'dog');
  assert.equal(body[0].born, '2020-01-31');
});

test('responses use media examples, and Prefer picks a named one', async () => {
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a"}' };
  const first = await fetch(`${base}/pets`, post);
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as any).name, 'Rex');
  const second = await fetch(`${base}/pets`, { ...post, headers: { ...post.headers, prefer: 'example=second' } });
  assert.equal(((await second.json()) as any).name, 'Tom');
  assert.deepEqual(await (await fetch(`${base}/pets/mine`)).json(), { mine: true });
});

test('Prefer: code forces a declared status, default, or 404', async () => {
  const limited = await fetch(`${base}/pets`, { headers: { prefer: 'code=429' } });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'rate limited' });
  const fallback = await fetch(`${base}/pets`, { headers: { prefer: 'code=503' } });
  assert.equal(fallback.status, 503);
  assert.deepEqual(Object.keys((await fallback.json()) as any), ['message']);
  const header = await fetch(`${base}/pets`, { headers: { 'x-mock-code': '429' } });
  assert.equal(header.status, 429);
  const missing = await fetch(`${base}/pets/1`, { headers: { prefer: 'code=418' } });
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as any).error, /418/);
  const invalid = await fetch(`${base}/pets/abc`, { headers: { prefer: 'code=200' } });
  assert.equal(invalid.status, 400);
});

test('204 has no body and binary media gets bytes', async () => {
  const gone = await fetch(`${base}/pets/1`, { method: 'DELETE' });
  assert.equal(gone.status, 204);
  assert.equal(await gone.text(), '');
  const file = await fetch(`${base}/files/a.json`);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.ok((await file.arrayBuffer()).byteLength > 0);
});

test('server-sent events from schema and from scripted examples', async () => {
  const res = await fetch(`${base}/events`, { headers: { 'x-mock-stream-count': '3' } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.equal(text, 'data: {"n":0}\n\n'.repeat(3));
  const scripted = await (await fetch(`${base}/scripted`)).text();
  assert.equal(scripted, 'event: start\ndata: {"step":1}\n\nevent: end\ndata: [DONE]\n\n');
});

test('text responses and urlencoded requests', async () => {
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=a' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'string');
});

test('generator handles recursion, formats, discriminators and bounds', () => {
  const pet = generate(PETS, { $ref: '#/components/schemas/Pet' }) as Record<string, any>;
  assert.equal(typeof pet.owner, 'object');
  assert.ok(Array.isArray(pet.owner.pets));
  const diet = generate(PETS, PETS.components.schemas.NewPet.allOf[1].properties.diet) as Record<string, unknown>;
  assert.deepEqual(diet, { type: 'meat', grams: 0 });
  const mismatch = {
    components: {
      schemas: {
        U: { oneOf: [{ $ref: '#/components/schemas/A' }], discriminator: { propertyName: 'kind', mapping: { 'A TYPE': '#/components/schemas/A' } } },
        A: { type: 'object', properties: { kind: { type: 'string', enum: ['A'] } } },
        B: { oneOf: [{ $ref: '#/components/schemas/C' }], discriminator: { propertyName: 'kind' } },
        C: { type: 'object', properties: { kind: { type: 'string' } } },
      },
    },
  };
  assert.deepEqual(generate(mismatch, { $ref: '#/components/schemas/U' }), { kind: 'A' });
  assert.deepEqual(generate(mismatch, { $ref: '#/components/schemas/B' }), { kind: 'C' });
  assert.equal(generate(PETS, { type: 'integer', minimum: 5 }), 5);
  assert.equal(generate(PETS, { type: 'number', exclusiveMinimum: 0 }), 0.5);
  assert.equal(generate(PETS, { type: 'string', format: 'uuid' }), '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e');
  assert.equal(generate(PETS, { type: ['null', 'string'] }), 'string');
  assert.deepEqual(generate(PETS, { anyOf: [{ type: 'null' }, { type: 'boolean' }] }), true);
  assert.deepEqual(generate(PETS, { type: 'array', items: { type: 'integer' } }, { arrayMin: 3, arrayMax: 3 }), [0, 0, 0]);
  const loop = { components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } } };
  assert.ok(JSON.stringify(generate(loop, { $ref: '#/components/schemas/Node' })).length < 200);
});

test('Prefer header parsing', () => {
  assert.deepEqual(parsePrefer('code=429, example=slow'), { code: '429', example: 'slow' });
  assert.deepEqual(parsePrefer('respond-async; code="500"'), { code: '500', example: null });
  assert.deepEqual(parsePrefer(undefined), { code: null, example: null });
});

test('wildcard response media types are served as a concrete type', () => {
  const doc = { components: { schemas: { File: { type: 'string', format: 'binary' } } } };
  assert.equal(concreteType(doc, '*/*', { schema: { type: 'object' } }, { a: 1 }), 'application/json');
  assert.equal(concreteType(doc, '*/*', { schema: { type: 'integer' } }, 3), 'application/json');
  assert.equal(concreteType(doc, '*/*', { schema: { type: 'string' } }, 'x'), 'text/plain');
  assert.equal(concreteType(doc, '*/*', { schema: { $ref: '#/components/schemas/File' } }, 'x'), 'application/octet-stream');
  assert.equal(concreteType(doc, 'image/*', {}, ''), 'application/octet-stream');
  assert.equal(concreteType(doc, 'application/json', {}, {}), 'application/json');
});

test('examples that contradict their schema are replaced by generated values', () => {
  const doc = { components: { schemas: { Zip: { type: 'string', example: 85014 } } } };
  const value = generate(doc, { type: 'object', required: ['zip', 'area'], properties: { zip: { $ref: '#/components/schemas/Zip' }, area: { type: 'integer', example: 'current' }, name: { type: 'string', example: 'ok' } } }) as Record<string, unknown>;
  assert.equal(typeof value.zip, 'string');
  assert.equal(typeof value.area, 'number');
  assert.equal(value.name, 'ok');
  assert.equal(conforms(doc, { type: 'array', items: { type: 'integer' } }, [1, 2]), true);
  assert.equal(conforms(doc, { type: 'array', items: { type: 'integer' } }, [1, 'x']), false);
  assert.equal(conforms(doc, { type: 'string', nullable: true }, null), true);
  assert.equal(conforms(doc, { type: 'string', format: 'date' }, '2020-04-07T17:04:26Z'), false);
  assert.equal(conforms(doc, { type: 'string', format: 'date-time' }, '2020-04-07T17:04:26Z'), true);
  assert.equal(conforms(doc, { items: { properties: { id: { type: 'string' } } } }, ['123456']), false);
  assert.equal(conforms(doc, { oneOf: [{ type: 'string' }, { type: 'integer' }] }, 3), true);
  assert.equal(conforms(doc, { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, {}), false);
  const plan = planResponse(doc, { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { n: { type: 'integer' } } }, example: { n: 'one' } } } } } }, { code: null, example: null }, undefined, {});
  assert.ok(plan.ok && plan.response.source === 'generated', 'a media example that contradicts the schema is not served');
});

test('lenient parameter and schema quirks from real specs', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Quirks', version: '1' },
    paths: {
      '/images': {
        get: {
          parameters: [
            { name: 'fields', in: 'query', style: 'form', explode: false, schema: { type: 'array', nullable: true, items: { type: 'string' } } },
            { name: 'include', in: 'query', schema: { type: 'array', items: { type: 'string' }, enum: ['rooms', 'pool'] } },
          ],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' }, examples: { a: { value: { type: 'Object' } } } } } } },
        },
      },
      '/recordings/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } },
      '/recordings/{id}.mp3': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } },
      '//openapi': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/odd': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/paths/~1images/get/responses/200/content/application~1json/examples/a/value' } } } } } } },
    },
  };
  const server = await listen(createMock(specFromDocument(doc as any)), 0, '127.0.0.1');
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${at}/images?fields=id`)).status, 200, 'a single item of a nullable comma array is an array');
    assert.equal((await fetch(`${at}/images?include=rooms`)).status, 200, 'an enum on a Swagger 2 array applies to its items');
    assert.equal((await fetch(`${at}/images?include=nope`)).status, 400);
    assert.equal((await fetch(`${at}/odd`)).status, 200, 'a capitalized type does not make the spec unloadable');
    assert.equal((await fetch(`${at}/recordings/1.mp3`)).status, 200, 'a segment with a literal suffix wins over a bare parameter');
    assert.equal((await fetch(`${at}//openapi`)).status, 200, 'a path that starts with // is routed, not read as a host');
  } finally {
    server.close();
  }
});

test('generated variants carry their discriminator tag, and optional recursion stops cleanly', () => {
  const doc = {
    components: {
      schemas: {
        Base: { oneOf: [{ $ref: '#/components/schemas/TimeDelta' }], discriminator: { propertyName: '__type', mapping: { TimeDelta: '#/components/schemas/TimeDelta' } } },
        TimeDelta: { type: 'object', required: ['__type'], properties: { __type: { type: 'string' }, days: { type: 'integer' } } },
        Comment: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, parent: { $ref: '#/components/schemas/Comment' } } },
      },
    },
  };
  assert.equal((generate(doc, { $ref: '#/components/schemas/TimeDelta' }) as Record<string, unknown>).__type, 'TimeDelta');
  let comment = generate(doc, { $ref: '#/components/schemas/Comment' }) as Record<string, any>;
  let levels = 0;
  while (comment) {
    assert.equal(typeof comment.type, 'string', 'every generated level keeps its required fields');
    comment = comment.parent;
    levels += 1;
  }
  assert.ok(levels >= 2);
});

test('array length headers and options change generated arrays', async () => {
  const sized = await fetch(`${base}/pets`, { headers: { 'x-mock-array-size': '3' } });
  assert.equal((((await sized.json()) as any[])).length, 3);
  const bounded = await fetch(`${base}/pets`, { headers: { 'x-mock-array-max': '4' } });
  assert.equal((((await bounded.json()) as any[])).length, 4);
  assert.deepEqual(generate(PETS, { type: 'array', items: { type: 'integer' } }, { arrayMax: 2 }), [0, 0]);
  assert.deepEqual(generate(PETS, { type: 'array', items: { type: 'integer' }, maxItems: 1 }, { arrayMax: 2 }), [0]);
});

test('stream counts are capped and invalid format headers are ignored', async () => {
  const res = await fetch(`${base}/events`, { headers: { 'x-mock-stream-count': '999999999' } });
  const text = await res.text();
  assert.equal(text.split('\n\n').filter((e) => e.trim() !== '').length, 10000);
  const odd = await fetch(`${base}/pets?tags=a,b`, { headers: { 'x-mock-query-array-format': 'bogus' } });
  assert.equal(odd.status, 200);
});

test('xml responses are serialized as elements', () => {
  assert.equal(encodeBody('application/xml', { pet: { id: 1, tags: ['a', 'b<'] } }).toString(), '<?xml version="1.0" encoding="UTF-8"?>\n<root><pet><id>1</id><tags>a</tags><tags>b&lt;</tags></pet></root>');
});
