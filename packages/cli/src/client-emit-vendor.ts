// The vendor client: one async method per operation of a third party's document, each a single
// `outbound()` call — the caller's wrapper decides `dial` and the deadline. Input is parsed with
// `t` before a byte leaves; the answer through `answer.json(schema)`, so a renamed field is
// `X_OUTBOUND_BODY_INVALID` naming it, and a documented non-2xx is outbound's `X_OUTBOUND_REFUSED`.

import { emitSchemas, opSchemaRef } from './client-emit-schemas';
import type { DocumentNames } from './client-emit-types';
import { documentNames, propertyKey } from './client-emit-types';
import type { ClientOperation, CompiledDocument } from './openapi-compile-ir';
import { typeName } from './openapi-compile-schema';

export interface VendorFiles {
  readonly 'client.ts': string;
  readonly 'schemas.ts': string;
}

const RUNTIME = (
  pascal: string,
  vendor: string,
): string => `/** How this vendor is reached: decided by the app's own wrapper, never by the document. */
export interface ${pascal}ClientOptions {
  readonly baseUrl: string;
  /** \`'public'\` for an internet vendor; \`'named'\` for a host the app names in config. */
  readonly dial: 'named' | 'public';
  /** The whole call, retries included. */
  readonly deadlineMs: number;
  /** Called before every request: credentials are the app's to store. */
  readonly headers?:
    | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>)
    | undefined;
  readonly deps?: OutboundDeps | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

interface CallSpec {
  readonly method: OutboundMethod;
  readonly path: string;
  readonly params: object;
  readonly pathParams: readonly string[];
  readonly query: readonly string[];
  readonly headers: readonly string[];
  readonly body?: unknown;
}

const read = (input: object, key: string): unknown =>
  Object.hasOwn(input, key) ? (input as Readonly<Record<string, unknown>>)[key] : undefined;

function sender(options: ${pascal}ClientOptions) {
  return async (spec: CallSpec, call: CallOptions) => {
    let path = spec.path;
    for (const name of spec.pathParams) {
      path = path.replace(\`{\${name}}\`, encodeURIComponent(String(read(spec.params, name))));
    }
    const url = new URL(\`\${options.baseUrl.replace(/\\/$/, '')}\${path}\`);
    for (const name of spec.query) {
      const value = read(spec.params, name);
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...(await options.headers?.()) };
    for (const name of spec.headers) {
      const value = read(spec.params, name);
      if (value !== undefined) headers[name] = String(value);
    }
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    return outbound(
      {
        url,
        vendor: ${JSON.stringify(vendor)},
        dial: options.dial,
        deadlineMs: options.deadlineMs,
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      },
      options.deps,
    );
  };
}
`;

function operationMethod(op: ClientOperation, names: DocumentNames): string {
  const types = names.operation.get(op.name);
  const request = types?.request === undefined ? undefined : `S.${types.request.name}`;
  const response = types?.response === undefined ? 'void' : `S.${types.response.name}`;
  const params = opSchemaRef(op, 'Params', names);
  const bodySchema = opSchemaRef(op, 'Body', names);
  const responseSchema = opSchemaRef(op, 'Response', names);
  const where = (place: 'path' | 'query' | 'header'): string =>
    JSON.stringify(op.parameters.filter((p) => p.in === place).map((p) => p.name));
  const bodyValue =
    op.body === undefined || bodySchema === undefined
      ? undefined
      : op.body.mode === 'value'
        ? `${bodySchema}.parse(input.body)`
        : `${bodySchema}.parse(input)`;
  const optionalBody = op.body?.required === false && op.body.mode === 'value';
  const body =
    bodyValue === undefined
      ? ''
      : optionalBody
        ? `\n        body: input.body === undefined ? undefined : ${bodyValue},`
        : `\n        body: ${bodyValue},`;
  const doc = op.summary === undefined ? '' : `    /** ${op.summary.replace(/\*\//g, '* /')} */\n`;
  const input = request === undefined ? 'input: Record<string, never> = {}' : `input: ${request}`;
  return `${doc}    async ${propertyKey(op.name)}(${input}, call: CallOptions = {}): Promise<${response}> {
      const answer = await send({
        method: ${JSON.stringify(op.method)},
        path: ${JSON.stringify(op.path)},
        params: ${params === undefined ? '{}' : `${params}.parse(input)`},
        pathParams: ${where('path')},
        query: ${where('query')},
        headers: ${where('header')},${body}
      }, call);
      ${responseSchema === undefined ? 'void answer;' : `return answer.json(${responseSchema});`}
    },`;
}

/** Both files' text, unstamped. `name` is the vendor label every log line and cause carries. */
export function emitVendor(name: string, document: CompiledDocument): VendorFiles {
  const names = documentNames(document);
  const pascal = typeName(name);
  const client = [
    `// The ${name} client, compiled from ${document.title} ${document.version}: one outbound() call per operation.`,
    "import type { OutboundDeps, OutboundMethod } from '@ultimat3/core/outbound';",
    "import { outbound } from '@ultimat3/core/outbound';",
    "import * as S from './schemas';",
    '',
    RUNTIME(pascal, name),
    `/** One method per operation of ${document.title}, named by its \`operationId\`. */`,
    `export function create${pascal}Client(options: ${pascal}ClientOptions) {`,
    '  const send = sender(options);',
    '  return {',
    ...document.operations.map((op) => operationMethod(op, names)),
    '  };',
    '}',
    '',
    `export type ${pascal}Client = ReturnType<typeof create${pascal}Client>;`,
    '',
  ].join('\n');
  return { 'client.ts': client, 'schemas.ts': emitSchemas(document) };
}
