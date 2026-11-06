// The neutral form `openapi-compile.ts` reduces an OpenAPI document to, and both client emitters
// read: named types, operations, and nothing that still needs the document. Types only — the
// compiler is the one reader of OpenAPI, the emitters never see a JSON pointer they must resolve.

/** One value shape. `unknown` is a schema that states nothing (`{}`), never a construct skipped. */
export type ClientType =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'string' }
  | { readonly kind: 'number'; readonly integer: boolean }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'null' }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'array'; readonly items: ClientType }
  | { readonly kind: 'object'; readonly fields: readonly ClientField[] }
  | { readonly kind: 'record'; readonly values: ClientType }
  | { readonly kind: 'union'; readonly members: readonly ClientType[] }
  | { readonly kind: 'ref'; readonly name: string };

export type ClientObject = Extract<ClientType, { readonly kind: 'object' }>;

export interface ClientField {
  readonly name: string;
  readonly type: ClientType;
  readonly required: boolean;
}

export type ClientMethod = 'GET' | 'HEAD' | 'PUT' | 'DELETE' | 'POST' | 'PATCH' | 'OPTIONS';

export interface ClientParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly type: ClientType;
}

/**
 * How the request body reaches the input: `fields` spreads an object body's fields into the input
 * beside the parameters (a parameter of the same name reads the same field), `value` puts any
 * other body under `input.body`.
 */
export type ClientBody =
  | { readonly mode: 'fields'; readonly type: ClientType; readonly required: boolean }
  | { readonly mode: 'value'; readonly type: ClientType; readonly required: boolean };

export interface ClientOperation {
  /** A TypeScript identifier from `operationId` — stable, so a rename is a contract change. */
  readonly name: string;
  readonly method: ClientMethod;
  /** The template as the document states it: `/invoices/{invoiceId}`. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary?: string | undefined;
  readonly parameters: readonly ClientParameter[];
  readonly body?: ClientBody | undefined;
  /** The 2xx JSON body; `undefined` when the success answer has none. */
  readonly response?: ClientType | undefined;
  /** Codes a refusal may carry, read from `x-ultimate-errors` on the non-2xx answers. */
  readonly refusals: readonly string[];
}

export interface CompiledDocument {
  readonly title: string;
  readonly version: string;
  /** Named component schemas, sorted by name — only those an operation kept reaches. */
  readonly types: ReadonlyMap<string, ClientType>;
  /** Sorted by name. */
  readonly operations: readonly ClientOperation[];
}
