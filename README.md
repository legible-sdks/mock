# @legible-sdks/mock

OpenAPI 3.0 and 3.1 mock server for SDK tests. It validates each request against the spec and answers with a schema-shaped response.

```sh
npx @legible-sdks/mock openapi.yaml
npx @legible-sdks/mock --help
```

The spec is a local file or an http(s) URL. `legible-mock validate openapi.yaml` loads it, compiles every schema and exits without serving.

Per request: `Prefer: code=429` answers with that status, `Prefer: example=name` picks an example. Health check: `GET /_x-mock/health`. `--help` lists every option and header.

## License

MIT
