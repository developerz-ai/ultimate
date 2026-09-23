# Client data

**Every browser request goes through one function, and every entity row it returns lands in one
record per `entity:id`.** You never write `fetch`, never write a store, and never mirror a row
into a signal by hand. Declare the entity, return its row, call the typed client.

`As of 2026-09-22` this is **21.0.0 work and not released**. The HTTP half described here is in the
tree. The store that *receives* the records and the hooks that read it are in the tree too.
The store is installed the first time a realtime hook runs on the page. Before that, records reach
the page handle and are held there until the store is installed. Every section says which half
it is. The design is
[`docs/architecture/21-client-data-layer.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/21-client-data-layer.md).

## One idiom per task

| Task | Write | Status |
|---|---|---|
| declare what a record is | `entity('post', { columns: { id: uuid().primaryKey(), … } })` | shipped |
| an action that returns a record | `output: Post.$schema`, or a schema that contains it | shipped in 21.0.0 |
| a query whose rows are records | `rows: Post.$schema` on `query()` | shipped in 21.0.0 |
| call an action from an island | `rpc<Api['actions']>({ baseUrl: '' })` | shipped; now goes through the one transport |
| call a query from an island | `queryClient<Api['queries']>({ baseUrl: '' })` | shipped; now goes through the one transport |
| ignore an answer for a principal that signed out | `if (isSuperseded(error)) return;` | shipped in 21.0.0 |
| any other failure | `isUltimateError(error)`, then switch on `error.code` | shipped |
| install realtime in an island | nothing: `x build` does it for every island whose own graph imports `@ultimat3/realtime`. An island that reaches realtime only through a package calls `installRealtime({ signal: createSignal })` in `mount` | shipped in 21.0.0 |
| show one record in a component | `useRecord('post', id)`: record type, then record key, from `@ultimat3/realtime` | shipped in 21.0.0 |
| show a list | `useQuery({ name: 'postList', entity: 'post' }, input)`, or `{ name, live: true }` for a live query | shipped in 21.0.0 |
| follow a channel | declare it on one ref in two halves: `channelRef('org-feed', { params, catchUp })` for the browser, `channel(ORG_FEED, { records, policy })` on the server. Then `useChannel(ORG_FEED, { orgId }, { onEvent, onPresence })` in the island: records reach the store, events the handlers. `usePresence(ORG_FEED, params)` for a roster | shipped in 21.0.0 |
| sign out | an action (the reference app's `endSession`, `POST /api/sessions/end`), posted by a native form, whose response appends `signOutHeaders()` from `@ultimat3/auth`: `Clear-Site-Data: "cache", "storage"` empties the page store, local storage and the service worker's cache. The redirect is a full navigation, so the next document carries the new scope | shipped in 21.0.0 |
| keep a record type on disk across reloads | `entity('post', { columns, persist: true })`. Default `false`: a record is private data, and disk is a decision | shipped in 21.0.0 |
| write with an optimistic update | `useMutation({ name: 'renamePost', local, conflict })`, posted over HTTP | shipped in 21.0.0 |

Never write `fetch(` in an island. `bun run browser-transport` refuses it with
`X_BROWSER_TRANSPORT_BYPASS` and names the line. `As of 2026-09-22` it is a standalone command,
not yet a step of `x verify`.

## 1. The entity is the record

```ts
// app/posts/entity.ts
import { entity, text, uuid } from '@ultimat3/entity';

export const Post = entity('post', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 120 }) },
});
```

The record type is the entity name (`post`). The record key is the primary key, in declared order.
Nothing else is declared.

## 2. An action that returns the row

```ts
// app/posts/actions.ts
import { action, t } from '@ultimat3/action';
import { Post } from './entity';
import { postWrite } from './policies';
import { repo } from './repo';

export const renamePost = action({
  input: t.object({ postId: t.uuid, title: t.string }),
  output: Post.$schema, // or t.object({ post: Post.$schema.nullable() }): found at any depth
  policy: postWrite,
  handle: ({ input }) => repo.rename(input.postId, input.title), // returns the WHOLE row
});
```

Because the output schema references `Post.$schema`, the response is `{ data, records }` with the
header `x-ultimate-records: 1`. Nothing to declare. `.pick()`, `.omit()` or `.extend()` on the row
schema drops the brand, so a partial row never overwrites a full record.

## 3. A query whose rows are records

```ts
// app/posts/queries.ts
import { from, query, t } from '@ultimat3/query';
import { Post } from './entity';
import { postRead } from './policies';
import { repo } from './repo';

type PostRow = typeof Post.$row;

export const postList = query({
  input: t.object({ orgId: t.uuid }),
  policy: postRead,
  rows: Post.$schema, // without this line the rows never reach the store
  sql: ({ orgId }) =>
    from<PostRow>('posts', () => repo.listByOrg(orgId)).where({ orgId }).orderBy('id'),
});
```

`sql:` names its table as a string, so `rows:` is the one place the schema comes from. Leave it
off and the query still works, but its answer is bare rows the store never sees.

## 4. Call both from an island

```ts
// shared/browser-client.ts — type-only import of the api, so no server code reaches the island
import { rpc } from '@ultimat3/action';
import { queryClient } from '@ultimat3/query/client'; // the browser entry: 16,458 B vs 23,611 B via the barrel
import type { Api } from '../api';

export const actions = rpc<Api['actions']>({ baseUrl: '' });
export const queries = queryClient<Api['queries']>({ baseUrl: '' });
```

```ts
// app/posts/rename.island.tsx
import { isSuperseded, isUltimateError } from '@ultimat3/core';
import { actions } from '../../shared/browser-client';

export async function rename(postId: string, title: string): Promise<void> {
  try {
    await actions.renamePost({ postId, title }); // returns `data`, the envelope is stripped
  } catch (error) {
    if (isSuperseded(error)) return; // the page changed principal: render nothing
    if (isUltimateError(error) && error.code === 'X_CLIENT_TRANSPORT_FAILED') {
      // no usable answer: the network, a proxy, or a non-JSON body
    }
    throw error;
  }
}
```

`baseUrl: ''` is the page's own origin. A browser chunk has no `process.env`.

## How a record travels

| # | Where | What happens | Status |
|---|---|---|---|
| 1 | server | the action or query route runs `rowsOf(schema, answer)`, collecting every branded row as record type → record key → row | in tree |
| 2 | wire | `{ data, records, removed? }` behind `x-ultimate-records: 1`. An answer with no entity rows is byte-identical to before | in tree |
| 3 | browser | `clientTransport` decodes the envelope, checks the principal has not changed, and calls `pageClient().store.adopt(type, rows)` | in tree |
| 4 | browser | the one `RecordStore` per tab, shared by every island through `globalThis[Symbol.for('ultimate.client')]`, updates the record once | in tree (`packages/realtime/src/page-store.ts`). Installed by the first realtime hook on the page. Until one runs, step 3 finds no store and the page **holds** the records (`packages/core/src/pending-records.ts`), handing them over on install |
| 5 | component | every `useRecord` / `useQuery` showing that record re-renders, with no refetch | in tree |

## Errors you will hit

| Code | When | Fix |
|---|---|---|
| `X_CLIENT_TRANSPORT_FAILED` | no usable answer: the network refused, a proxy answered a non-2xx with no framework code, or a 2xx body was not JSON | `x doctor --json` checks the network and the gateway in front of the app, then retry. A write with no `idempotencyKey` may already have landed |
| `X_CLIENT_SCOPE_CHANGED` | the page changed principal while a read was in flight | `if (isSuperseded(error)) return;`, then read again under the new principal |
| `X_CLIENT_RECORD_ENVELOPE_INVALID` | a response carried `x-ultimate-records: 1` and a body of the wrong shape | build the body with `encodeRecordEnvelope()` from `@ultimat3/core` in the handler that set the header, or stop setting the header |
| `X_RECORD_KEY_MISSING` | a returned row lacks a primary-key column | `x entities describe <entity> --json` lists the key. Return the whole row |
| `X_MUTATOR_CLOCK_MISSING` | a mutator declares `conflict: 'last-write-wins'` and its entity has no number `updatedAt`, or its output has no entity row | add `updatedAt` (a number, epoch ms, written by the server) to the entity, or declare `conflict: 'server-wins'` |
| `X_REALTIME_UNINSTALLED` | a realtime hook ran in an island that never called `installRealtime()` | `x build`. If the island reaches realtime only through a package, call `installRealtime({ signal: createSignal })` in its `mount` |
| `X_RECORD_REJECTED` | a row reached the store with no key, or not as an object | `x entities describe <entity> --json` lists the key. Return whole rows |
| `X_CONTRACT_DRIFT` | the client bundle and the server are on different builds | reload the page to pick up the new client bundle |

Full rows: [Error codes](Error-Codes).
