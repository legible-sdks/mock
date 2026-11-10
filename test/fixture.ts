import { createMock, type Mock, type MockOptions } from '../src/server.ts';
import { type Obj, specFromDocument } from '../src/spec.ts';

export const PETS: Obj = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } } },
          { name: 'filter', in: 'query', schema: { $ref: '#/components/schemas/Filter' } },
          { name: 'status.in', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'X-Trace', in: 'header', required: false, schema: { type: 'integer' } },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'active', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            headers: { 'X-Total': { schema: { type: 'integer', example: 3 } } },
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
          },
          '429': { description: 'slow down', content: { 'application/json': { example: { error: 'rate limited' } } } },
          default: { description: 'error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } },
        responses: {
          '201': {
            description: 'created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pet' },
                examples: { first: { value: { id: 1, name: 'Rex', kind: 'dog' } }, second: { value: { id: 2, name: 'Tom', kind: 'cat' } } },
              },
            },
          },
        },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      delete: { responses: { '204': { description: 'gone' } } },
    },
    '/pets/mine': {
      get: { responses: { '200': { description: 'ok', content: { 'application/json': { example: { mine: true } } } } } },
    },
    '/pets/{petId}/photo': {
      post: {
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file', 'caption'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  caption: { type: 'string' },
                  meta: { type: 'object', properties: { width: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } } },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
      },
    },
    '/login': {
      post: {
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['user'],
                properties: { user: { type: 'string' }, remember: { type: 'boolean' }, scopes: { type: 'array', items: { type: 'string' } }, extra: { type: 'object', properties: { a: { type: 'integer' } } } },
              },
            },
          },
        },
        responses: { '200': { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
    '/events': {
      get: {
        responses: {
          '200': { description: 'stream', content: { 'text/event-stream': { schema: { type: 'object', properties: { n: { type: 'integer' } } } } } },
        },
      },
    },
    '/scripted': {
      get: {
        responses: {
          '200': {
            description: 'stream',
            content: { 'text/event-stream': { example: [{ event: 'start', data: { step: 1 } }, { event: 'end', data: '[DONE]' }] } },
          },
        },
      },
    },
    '/files/{name}.json': {
      get: {
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Filter: { type: 'object', properties: { color: { type: 'string' }, age: { type: 'object', properties: { gt: { type: 'integer' } } }, ids: { type: 'array', items: { type: 'integer' } } } },
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer', readOnly: true },
          name: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ['dog', 'cat'] },
          born: { type: 'string', format: 'date', nullable: true },
          owner: { $ref: '#/components/schemas/Owner' },
        },
      },
      Owner: { type: 'object', nullable: true, properties: { name: { type: 'string' }, pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
      NewPet: {
        allOf: [
          { $ref: '#/components/schemas/Pet' },
          {
            type: 'object',
            properties: {
              diet: {
                oneOf: [{ $ref: '#/components/schemas/Meat' }, { $ref: '#/components/schemas/Plants' }],
                discriminator: { propertyName: 'type', mapping: { meat: '#/components/schemas/Meat', plants: '#/components/schemas/Plants' } },
              },
              email: { type: 'string', format: 'email' },
              weight: { type: 'number', exclusiveMinimum: true, minimum: 0 },
            },
          },
        ],
      },
      Meat: { type: 'object', required: ['type', 'grams'], properties: { type: { type: 'string', enum: ['meat'] }, grams: { type: 'integer' } } },
      Plants: { type: 'object', required: ['type', 'leaves'], properties: { type: { type: 'string', enum: ['plants'] }, leaves: { type: 'array', items: { type: 'string' } } } },
      Error: { type: 'object', properties: { message: { type: 'string' } } },
    },
  },
};

export function petsMock(options: Partial<MockOptions> = {}, doc: Obj = PETS): Mock {
  return createMock(specFromDocument(structuredClone(doc)), { logLevel: 'silent', ...options });
}

export function json(value: unknown): { headers: Record<string, string>; body: Buffer } {
  return { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) };
}

export function errors(mock: Mock, method: string, url: string, headers: Record<string, string> = {}, body: Buffer = Buffer.alloc(0)): string[] {
  return mock
    .validate(method, url, headers, body)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => `${i.code} ${i.location}`);
}

export function warnings(mock: Mock, method: string, url: string, headers: Record<string, string> = {}, body: Buffer = Buffer.alloc(0)): string[] {
  return mock
    .validate(method, url, headers, body)
    .issues.filter((i) => i.severity === 'warning')
    .map((i) => `${i.code} ${i.location}`);
}

export function multipart(boundary: string, parts: Array<{ name: string; value: string; filename?: string; type?: string }>): Buffer {
  let text = '';
  for (const part of parts) {
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n`;
    if (part.type) text += `Content-Type: ${part.type}\r\n`;
    text += `\r\n${part.value}\r\n`;
  }
  return Buffer.from(`${text}--${boundary}--\r\n`);
}
