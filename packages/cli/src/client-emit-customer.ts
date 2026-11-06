// The customer client: what a third party's TypeScript calls the app's published API with. Zero
// imports beyond the platform — `fetch`, types, and a `ProblemError` read from the RFC 9457 body —
// so the directory is publishable as it is. `rpc` stays the client inside the app's own repo.

import { CUSTOMER_RUNTIME } from './client-emit-customer-runtime';
import type { DocumentNames } from './client-emit-types';
import { documentNames, propertyKey, typeText } from './client-emit-types';
import type { ClientOperation, CompiledDocument } from './openapi-compile-ir';

export interface CustomerFiles {
  readonly 'index.ts': string;
  readonly 'types.ts': string;
}

function typesFile(document: CompiledDocument, names: DocumentNames): string {
  const lines: string[] = [
    `// The types of ${document.title} ${document.version}, one per schema the operations reach.`,
    '',
  ];
  for (const [name, type] of document.types) {
    lines.push(`export type ${names.component(name)} = ${typeText(type, names.component)};`);
  }
  for (const op of document.operations) {
    const types = names.operation.get(op.name);
    for (const named of [types?.request, types?.response]) {
      if (named?.text !== undefined) lines.push(`export type ${named.name} = ${named.text};`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The field names a `fields` body sends, its `$ref` followed into the document's types. */
export function bodyKeys(document: CompiledDocument, op: ClientOperation): readonly string[] {
  const type = op.body?.type;
  const target = type?.kind === 'ref' ? document.types.get(type.name) : type;
  return target?.kind === 'object' ? target.fields.map((field) => field.name) : [];
}

/** The call one operation makes: where each parameter goes, and what the body is. */
function callSpec(document: CompiledDocument, op: ClientOperation): string {
  const where = (place: 'path' | 'query' | 'header'): string =>
    JSON.stringify(op.parameters.filter((p) => p.in === place).map((p) => p.name));
  const body =
    op.body === undefined
      ? "'none'"
      : op.body.mode === 'value'
        ? "'value'"
        : JSON.stringify(bodyKeys(document, op));
  return `{ operation: ${JSON.stringify(op.name)}, method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}, pathParams: ${where('path')}, query: ${where('query')}, headers: ${where('header')}, body: ${body}, empty: ${String(op.response === undefined)} }`;
}

function operationLine(
  document: CompiledDocument,
  op: ClientOperation,
  names: DocumentNames,
): string {
  const types = names.operation.get(op.name);
  const request = types?.request === undefined ? undefined : `T.${types.request.name}`;
  const response = types?.response === undefined ? 'void' : `T.${types.response.name}`;
  const doc = op.summary === undefined ? '' : `    /** ${op.summary.replace(/\*\//g, '* /')} */\n`;
  const input = request === undefined ? 'input: Record<string, never> = {}' : `input: ${request}`;
  return `${doc}    ${propertyKey(op.name)}: (${input}, call: CallOptions = {}): Promise<${response}> =>\n      send(${callSpec(document, op)}, input, call) as Promise<${response}>,`;
}

/** Both files' text, unstamped: the command adds the header with the source hash. */
export function emitCustomer(document: CompiledDocument): CustomerFiles {
  const names = documentNames(document);
  const refusals = document.operations.map(
    (op) =>
      `  ${propertyKey(op.name)}: ${op.refusals.length === 0 ? 'never' : op.refusals.map((code) => JSON.stringify(code)).join(' | ')};`,
  );
  const declared = document.operations.map(
    (op) => `  ${propertyKey(op.name)}: ${JSON.stringify(op.refusals)},`,
  );
  const index = [
    `// The client for ${document.title} ${document.version}: one method per published operation.`,
    "import type * as T from './types';",
    '',
    CUSTOMER_RUNTIME,
    '/** The codes each operation declares it may refuse with; `never` when it declares none. */',
    'export interface Refusals {',
    ...refusals,
    '}',
    '',
    'const DECLARED: { readonly [K in keyof Refusals]: readonly string[] } = {',
    ...declared,
    '};',
    '',
    '/** The declared refusal `error` carries for `operation`, narrowed; `undefined` for anything else. */',
    'export function refusalOf<K extends keyof Refusals>(error: unknown, operation: K): Refusals[K] | undefined {',
    '  if (!(error instanceof ProblemError) || error.operation !== operation) return undefined;',
    '  const code = error.code;',
    '  return code !== undefined && DECLARED[operation].includes(code) ? (code as Refusals[K]) : undefined;',
    '}',
    '',
    '/** One method per operation, named by its `operationId`. */',
    'export function createClient(options: ClientOptions) {',
    '  const send = sender(options);',
    '  return {',
    ...document.operations.map((op) => operationLine(document, op, names)),
    '  };',
    '}',
    '',
    'export type Client = ReturnType<typeof createClient>;',
    '',
  ].join('\n');
  return { 'index.ts': index, 'types.ts': typesFile(document, names) };
}
