/**
 * The ONE per-tab client handle, and the seam records flow through into it. Every island bundle
 * carries its own copy of `@ultimat3/core`, so a module-scope singleton here would be one store
 * PER ISLAND; the handle lives on `globalThis` under one `Symbol.for` key instead — the pattern
 * `ultimate.error` already uses — and every copy resolves the same object.
 */

import type { ClientScope } from './client-scope';
import { CLIENT_SCOPE_META } from './page-meta';
import type { PendingRecords } from './pending-records';
import { pendingRecords } from './pending-records';
import type { RecordRows } from './record-envelope';

/**
 * Where decoded records land. `@ultimat3/realtime` installs the store. `adopt` MUST be idempotent
 * per `recordType + key`: a deduped read hands one answer to several callers and each adopts it.
 */
export interface RecordSink {
  /** `rows` is record key -> row: the key is the server's, the browser cannot derive it. */
  adopt(recordType: string, rows: RecordRows): void;
  remove(recordType: string, keys: readonly string[]): void;
}

export interface PageClient {
  /**
   * The record store — `undefined` until realtime installs one. ASSIGNING it is the one install
   * path: records answered before then are held (browser pages only) and adopted into the new
   * store once, on assignment. With no `document` (SSR, a test, a server) they are dropped.
   */
  store: RecordSink | undefined;
  /** The page's one socket — typed by `@ultimat3/realtime`, which fills it. */
  socket: unknown;
  /** Who the page is acting for right now. Read-only here: `rescope()` is the one writer. */
  readonly scope: ClientScope;
}

/** The mutable half `client-scope.ts` owns. On the handle, so every module copy shares it. */
export interface ScopeCell {
  current: ClientScope;
  readonly listeners: Set<(next: ClientScope, prev: ClientScope) => void>;
}

/** Headers every outbound request carries, or nothing. See `outbound-headers.ts`. */
export type OutboundHeaders = () => Readonly<Record<string, string>>;

interface PageClientHandle extends PageClient {
  readonly scopeCell: ScopeCell;
  /** The early-records buffer, or `undefined` where there is no page to install a store on. */
  readonly pending: PendingRecords | undefined;
  outboundHeaders: OutboundHeaders | undefined;
}

const HANDLE_KEY: unique symbol = Symbol.for('ultimate.client');

type HandleHost = { [HANDLE_KEY]?: PageClientHandle };

/** Get-or-create. The only `globalThis` write in the client seam, and it happens on first call. */
export function pageClient(): PageClient {
  return handle();
}

/** The scope cell behind `pageClient().scope`. Internal: `client-scope.ts` is its one caller. */
export function scopeCell(): ScopeCell {
  return handle().scopeCell;
}

/**
 * Where decoded records go RIGHT NOW: the installed store, else the browser's pending buffer, else
 * nowhere. Internal: `client-transport.ts` is its one caller.
 */
export function recordSink(): RecordSink | undefined {
  const client = handle();
  return client.store ?? client.pending;
}

/** The early-records buffer, for `rescope()` to clear. Internal. */
export function heldRecords(): PendingRecords | undefined {
  return handle().pending;
}

/** The outbound-header slot. Internal: `outbound-headers.ts` writes it, the dispatch reads it. */
export function outboundSlot(): { outboundHeaders: OutboundHeaders | undefined } {
  return handle();
}

/**
 * The principal the server rendered into the page, read ONCE, when the handle is created. Three
 * answers: the tag's content, `null` for an empty tag (anonymous), `undefined` for no tag or no
 * `document` at all (unscoped — nobody's page). A later change is `rescope()`'s, never a re-read.
 */
function renderedPrincipal(): string | null | undefined {
  const doc: { querySelector?: (selector: string) => { content?: unknown } | null } | undefined =
    Reflect.get(globalThis, 'document');
  const tag = doc?.querySelector?.(`meta[name="${CLIENT_SCOPE_META}"]`);
  if (tag === undefined || tag === null) return undefined;
  return typeof tag.content === 'string' && tag.content !== '' ? tag.content : null;
}

function handle(): PageClientHandle {
  const host = globalThis as HandleHost;
  const existing = host[HANDLE_KEY];
  if (existing !== undefined) return existing;
  const cell: ScopeCell = {
    current: { principal: renderedPrincipal(), epoch: 0 },
    listeners: new Set(),
  };
  const pending = Reflect.has(globalThis, 'document') ? pendingRecords() : undefined;
  let store: RecordSink | undefined;
  const created: PageClientHandle = {
    socket: undefined,
    scopeCell: cell,
    pending,
    outboundHeaders: undefined,
    get store(): RecordSink | undefined {
      return store;
    },
    set store(next: RecordSink | undefined) {
      store = next;
      if (next !== undefined) pending?.drainInto(next);
    },
    get scope(): ClientScope {
      return cell.current;
    },
  };
  // Non-enumerable, so a test harness or a devtools dump walking `globalThis` never serialises
  // the store through it.
  Object.defineProperty(host, HANDLE_KEY, { value: created, configurable: true });
  return created;
}
