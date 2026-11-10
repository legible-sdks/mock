import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errors, json, multipart, petsMock, warnings } from './fixture.ts';

const mock = petsMock({ query: { array: 'comma', object: 'brackets' } });

test('routes: literal paths win, base path and unknown routes', () => {
  assert.equal(mock.validate('GET', '/pets/mine', {}, Buffer.alloc(0)).operation?.path, '/pets/mine');
  assert.equal(mock.validate('GET', '/pets/7', {}, Buffer.alloc(0)).operation?.path, '/pets/{petId}');
  assert.equal(mock.validate('GET', '/v1/pets/7', {}, Buffer.alloc(0)).operation?.path, '/pets/{petId}');
  assert.equal(mock.validate('GET', '/files/report.json', {}, Buffer.alloc(0)).params.name, 'report');
  assert.equal(mock.validate('GET', '/nope', {}, Buffer.alloc(0)).status, 404);
  assert.equal(mock.validate('PUT', '/pets', {}, Buffer.alloc(0)).status, 405);
  assert.equal(mock.validate('GET', '/pets/', {}, Buffer.alloc(0)).operation?.path, '/pets');
});

test('path parameters are coerced and validated', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets/12'), []);
  assert.deepEqual(errors(mock, 'GET', '/pets/abc'), ['structure.type path.petId']);
});

test('query scalars: types, booleans, repeats', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets?limit=5&active=true'), []);
  assert.deepEqual(errors(mock, 'GET', '/pets?limit=abc'), ['structure.type query.limit']);
  assert.deepEqual(errors(mock, 'GET', '/pets?limit=1.5'), ['structure.type query.limit']);
  assert.deepEqual(errors(mock, 'GET', '/pets?active=yes'), ['structure.type query.active']);
  assert.deepEqual(errors(mock, 'GET', '/pets?limit=1&limit=2'), ['serialization query.limit']);
});

test('query content issues warn by default and reject in strict mode', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets?limit=500&since=yesterday'), []);
  assert.deepEqual(warnings(mock, 'GET', '/pets?limit=500&since=yesterday').sort(), ['content.format query.since', 'content.maximum query.limit']);
  const strict = petsMock({ strict: true, query: { array: 'comma', object: 'brackets' } });
  assert.deepEqual(errors(strict, 'GET', '/pets?limit=500').length, 1);
  assert.deepEqual(errors(strict, 'GET', '/pets?zzz=1'), ['unknown-parameter query.zzz']);
  assert.deepEqual(errors(mock, 'GET', '/pets?zzz=1'), []);
});

test('query arrays follow the configured format', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets?tags=a,b'), []);
  assert.deepEqual(errors(mock, 'GET', '/pets?tags=a,z'), ['structure.enum query.tags.1']);
  assert.deepEqual(errors(mock, 'GET', '/pets?tags[]=a&tags[]=b'), ['serialization query.tags[]']);
  assert.deepEqual(errors(mock, 'GET', '/pets?tags=a&tags=b'), ['serialization query.tags']);
  assert.deepEqual(errors(mock, 'GET', '/pets?tags[0]=a'), ['serialization query.tags']);
  const repeat = petsMock({ query: { array: 'repeat', object: 'brackets' } });
  assert.deepEqual(errors(repeat, 'GET', '/pets?tags=a&tags=b'), []);
  assert.deepEqual(errors(repeat, 'GET', '/pets?tags=a,b'), ['structure.enum query.tags.0']);
  const brackets = petsMock({ query: { array: 'brackets', object: 'brackets' } });
  assert.deepEqual(errors(brackets, 'GET', '/pets?tags[]=a&tags[]=b'), []);
  assert.deepEqual(errors(brackets, 'GET', '/pets?tags=a'), ['serialization query.tags']);
  const indices = petsMock({ query: { array: 'indices', object: 'brackets' } });
  assert.deepEqual(errors(indices, 'GET', '/pets?tags[0]=a&tags[1]=b'), []);
  assert.deepEqual(errors(indices, 'GET', '/pets?tags[]=a'), ['serialization query.tags[]']);
  const auto = petsMock({ query: { array: null, object: null } });
  assert.deepEqual(errors(auto, 'GET', '/pets?tags=a&tags=b'), []);
});

test('query objects follow the configured format', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets?filter[color]=red&filter[age][gt]=3&filter[ids]=1,2'), []);
  assert.deepEqual(errors(mock, 'GET', '/pets?filter[age][gt]=old'), ['structure.type query.filter.age.gt']);
  assert.deepEqual(errors(mock, 'GET', '/pets?filter.color=red'), ['serialization query.filter.color']);
  const dots = petsMock({ query: { array: 'comma', object: 'dots' } });
  assert.deepEqual(errors(dots, 'GET', '/pets?filter.color=red&filter.age.gt=3&filter.ids=1,2'), []);
  assert.deepEqual(errors(dots, 'GET', '/pets?filter[color]=red'), ['serialization query.filter[color]']);
  assert.deepEqual(errors(dots, 'GET', '/pets?filter.ids[]=1'), ['serialization query.filter.ids[]']);
  assert.deepEqual(errors(dots, 'GET', '/pets?filter=red'), ['structure.type query.filter']);
});

test('flattened parameter names reject other serializations', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets?status.in=a,b'), []);
  assert.deepEqual(errors(mock, 'GET', '/pets?status[in]=a'), ['serialization query.status[in]']);
  assert.deepEqual(errors(mock, 'GET', '/pets?status.in[]=a'), ['serialization query.status.in[]']);
});

test('header parameters are coerced', () => {
  assert.deepEqual(errors(mock, 'GET', '/pets', { 'x-trace': '12' }), []);
  assert.deepEqual(errors(mock, 'GET', '/pets', { 'x-trace': 'abc' }), ['structure.type header.X-Trace']);
});

test('json bodies: required, types, enums, readOnly, nullable', () => {
  const ok = json({ name: 'Rex', kind: 'dog', born: null });
  assert.deepEqual(errors(mock, 'POST', '/pets', ok.headers, ok.body), []);
  const missing = json({ kind: 'dog' });
  assert.deepEqual(errors(mock, 'POST', '/pets', missing.headers, missing.body), ['structure.required body.name']);
  const wrong = json({ name: 3 });
  assert.deepEqual(errors(mock, 'POST', '/pets', wrong.headers, wrong.body), ['structure.type body.name']);
  const badEnum = json({ name: 'x', kind: 'cow' });
  assert.deepEqual(errors(mock, 'POST', '/pets', badEnum.headers, badEnum.body), ['structure.enum body.kind']);
  const array = json([]);
  assert.deepEqual(errors(mock, 'POST', '/pets', array.headers, array.body).length > 0, true);
});

test('json bodies: discriminator picks the variant', () => {
  const meat = json({ name: 'Rex', diet: { type: 'meat', grams: 10 } });
  assert.deepEqual(errors(mock, 'POST', '/pets', meat.headers, meat.body), []);
  const wrong = json({ name: 'Rex', diet: { type: 'meat', leaves: ['a'] } });
  assert.ok(errors(mock, 'POST', '/pets', wrong.headers, wrong.body).includes('structure.required body.diet.grams'));
  const unknown = json({ name: 'Rex', diet: { type: 'fish' } });
  assert.ok(errors(mock, 'POST', '/pets', unknown.headers, unknown.body).length > 0);
});

test('json bodies: formats and null mismatches are notes unless strict', () => {
  const body = json({ name: 'Rex', email: 'nope', weight: 0 });
  assert.deepEqual(errors(mock, 'POST', '/pets', body.headers, body.body), []);
  assert.equal(warnings(mock, 'POST', '/pets', body.headers, body.body).length, 2);
  const nulls = json({ name: null });
  assert.deepEqual(errors(mock, 'POST', '/pets', nulls.headers, nulls.body), []);
  const strict = petsMock({ strict: true });
  assert.deepEqual(errors(strict, 'POST', '/pets', nulls.headers, nulls.body), ['null.type body.name']);
});

test('json bodies: content type, empty and malformed bodies', () => {
  assert.deepEqual(errors(mock, 'POST', '/pets'), ['required body']);
  assert.deepEqual(errors(mock, 'POST', '/pets', { 'content-type': 'text/plain' }, Buffer.from('hi')), ['content-type header.content-type']);
  assert.deepEqual(errors(mock, 'POST', '/pets', { 'content-type': 'application/json' }, Buffer.from('{x')), ['json body']);
  assert.deepEqual(errors(mock, 'POST', '/pets', { 'content-type': 'application/json; charset=utf-8' }, Buffer.from('{"name":"a"}')), []);
});

test('multipart bodies: files, nested fields, required parts', () => {
  const type = { 'content-type': 'multipart/form-data; boundary=xyz' };
  const ok = multipart('xyz', [
    { name: 'file', value: 'PNG...', filename: 'a.png', type: 'image/png' },
    { name: 'caption', value: 'hello' },
    { name: 'meta[width]', value: '12' },
    { name: 'meta[tags][]', value: 'x' },
  ]);
  assert.deepEqual(errors(mock, 'POST', '/pets/1/photo', type, ok), []);
  const missing = multipart('xyz', [{ name: 'caption', value: 'hello' }]);
  assert.deepEqual(errors(mock, 'POST', '/pets/1/photo', type, missing), ['structure.required body.file']);
  const badNested = multipart('xyz', [
    { name: 'file', value: 'x', filename: 'a.png' },
    { name: 'caption', value: 'c' },
    { name: 'meta[width]', value: 'wide' },
  ]);
  assert.deepEqual(errors(mock, 'POST', '/pets/1/photo', type, badNested), ['structure.type body.meta.width']);
  assert.deepEqual(errors(mock, 'POST', '/pets/1/photo', type, Buffer.from('garbage')), ['multipart body']);
  const json = { 'content-type': 'application/json' };
  assert.deepEqual(errors(mock, 'POST', '/pets/1/photo', json, Buffer.from('{}')), ['content-type header.content-type']);
});

test('urlencoded bodies use the form formats', () => {
  const type = { 'content-type': 'application/x-www-form-urlencoded' };
  const form = petsMock({ form: { array: 'comma', object: 'dots' } });
  assert.deepEqual(errors(form, 'POST', '/login', type, Buffer.from('user=a&remember=true&scopes=x,y&extra.a=1')), []);
  assert.deepEqual(errors(form, 'POST', '/login', type, Buffer.from('remember=true')), ['structure.required body.user']);
  assert.deepEqual(errors(form, 'POST', '/login', type, Buffer.from('user=a&remember=maybe')), ['structure.type body.remember']);
  assert.deepEqual(errors(form, 'POST', '/login', type, Buffer.from('user=a&extra[a]=1')), ['serialization body.extra[a]']);
  assert.deepEqual(errors(form, 'POST', '/login', type, Buffer.from('user=a&scopes[]=x')), ['serialization body.scopes[]']);
  assert.deepEqual(errors(form, 'POST', '/login'), []);
});

test('oneOf is lenient by default and exact with strictOneOf', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/x': {
        post: {
          requestBody: { content: { 'application/json': { schema: { oneOf: [{ type: 'string' }, { type: 'string', maxLength: 3 }] } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const body = json('ab');
  assert.deepEqual(errors(petsMock({}, doc), 'POST', '/x', body.headers, body.body), []);
  assert.ok(errors(petsMock({ strictOneOf: true }, doc), 'POST', '/x', body.headers, body.body).length > 0);
});

test('OpenAPI 3.1 type arrays and const', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/x': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { a: { type: ['string', 'null'] }, k: { const: 'v' } } } } },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const m = petsMock({}, doc);
  const ok = json({ a: null, k: 'v' });
  assert.deepEqual(errors(m, 'POST', '/x', ok.headers, ok.body), []);
  const bad = json({ a: 1, k: 'w', z: 1 });
  assert.deepEqual(errors(m, 'POST', '/x', bad.headers, bad.body).sort(), ['structure.additional-property body.z', 'structure.const body.k', 'structure.type body.a']);
});


test('a nullable $ref admits null, and schemas that cannot compile are reported', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'n', version: '1' },
    paths: {
      '/x': {
        post: {
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { pet: { $ref: '#/components/schemas/Pet', nullable: true }, odd: { type: 'integer', minimum: 'abc' } }, required: ['pet'] } } } },
          responses: { '204': { description: 'ok' } },
        },
      },
      '/y': { get: { parameters: [{ name: 'q', in: 'query', schema: { type: 'integer', minimum: 'abc' } }], responses: { '204': { description: 'ok' } } } },
    },
    components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  };
  const m = petsMock({}, doc);
  const nothing = json({ pet: null });
  assert.deepEqual(errors(m, 'POST', '/x', nothing.headers, nothing.body), []);
  const wrong = json({ pet: { name: 1 } });
  assert.deepEqual(errors(m, 'POST', '/x', wrong.headers, wrong.body), ['structure.type body.pet.name']);
  const failures = m.validator.compileAll();
  assert.equal(failures.length, 2, JSON.stringify(failures));
  assert.match(failures[0]!.message, /minimum must be number/);
});

test('an array of objects in the query accepts bracket groups, and example-only allOf branches that break the schema are ignored', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'q', version: '1' },
    paths: {
      '/x': {
        get: {
          parameters: [{ name: 'filters', in: 'query', schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, op: { type: 'string', enum: ['=', '<'] } } } } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Link' } } } } },
        },
      },
    },
    components: { schemas: { Link: { allOf: [{ type: 'object', properties: { value: { type: 'object' } }, required: ['value'] }, { example: { value: 'not an object' } }] } } },
  };
  const m = petsMock({}, doc);
  assert.deepEqual(errors(m, 'GET', '/x?filters[name]=a&filters[op]=%3D'), []);
  assert.deepEqual(errors(m, 'GET', '/x?filters[0][name]=a&filters[1][op]=%3C'), []);
  assert.deepEqual(errors(m, 'GET', '/x?filters[0][op]=%3E'), ['structure.enum query.filters.0.op']);
});
