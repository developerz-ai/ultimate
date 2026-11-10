// The recording half of a cassette: a tap OVER the sealed `fetch` that copies each answer from a
// host `record.hosts` names, and the dispose that redacts, scans and writes them. Nothing here
// decides what gets through — the seal still does; `record.hosts` reaches it through `allowHost`.

import { stringField } from '@ultimat3/core';
import { CassetteRecordRefusedError, CassetteSecretError } from './cassette-errors';
import type { CassetteEntry } from './cassette-format';
import {
  CASSETTE_VERSION,
  encodeBody,
  keptHeaders,
  maskUrl,
  redactBody,
  serializeCassette,
} from './cassette-format';
import { findSecret, secretSources } from './cassette-secret-scan';
import type { FetchLike } from './sealed-network';

export interface RecordInput {
  readonly name: string;
  readonly dir: string;
  readonly file: string;
  readonly hosts: ReadonlySet<string>;
  readonly redact: ((text: string) => string) | undefined;
  readonly secrets: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Writes the checked bytes; ./cassette owns the filesystem. */
  readonly write: (text: string) => void;
}

export interface Recording {
  /** Removes the tap, then writes — or throws, and writes nothing. */
  finish(): Promise<void>;
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

const hostOf = (url: string): string | undefined =>
  URL.canParse(url) ? new URL(url).host : undefined;

export function startRecording(input: RecordInput): Recording {
  const sealed: FetchLike = globalThis.fetch;
  // One slot per call, taken BEFORE the await: the file keeps call order, not answer order.
  const slots: Promise<CassetteEntry>[] = [];
  const tap = (async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(request);
    const method = methodOf(request, init);
    const host = hostOf(url);
    const recorded = host !== undefined && input.hosts.has(host);
    let answer: Promise<Response>;
    try {
      answer = sealed(request, init);
      if (!recorded) return await answer;
    } catch (error) {
      // The seal's own refusal names `allowHost`; while recording, the line to edit is the
      // cassette's own `record.hosts`.
      if (stringField(error, 'code') === 'X_TEST_NETWORK_SEALED' && host !== undefined) {
        throw new CassetteRecordRefusedError({ reason: 'host', host, name: input.name });
      }
      throw error;
    }
    const slot = answer.then(async (response) => {
      const contentType = response.headers.get('content-type') ?? undefined;
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      return {
        method,
        url: maskUrl(url),
        status: response.status,
        headers: keptHeaders(response.headers),
        ...encodeBody(bytes, contentType),
      } satisfies CassetteEntry;
    });
    slots.push(slot);
    // A failed dial is the test's failure as it would be unrecorded; the slot fails `finish` too.
    slot.catch(() => undefined);
    return answer;
  }) as FetchLike;
  globalThis.fetch = tap;

  return {
    async finish() {
      // Only our own tap is removed: something that replaced it since owns `fetch` now.
      if (globalThis.fetch === tap) globalThis.fetch = sealed;
      // A body that failed to read rejects here, so a half run is never a recording.
      const entries = (await Promise.all(slots)).map((entry) => redacted(entry, input.redact));
      const text = await serializeCassette({ version: CASSETTE_VERSION, entries });
      // LAST, over the exact bytes about to be written — what `redact` returned included.
      const sources = secretSources(input.env, input.secrets);
      // A base64 body hides a value at any of three alignments, so its bytes are scanned too.
      const hit =
        findSecret(text, sources) ??
        entries
          .filter((entry) => entry.encoding === 'base64')
          .map((entry) => findSecret(Buffer.from(entry.body, 'base64').toString('latin1'), sources))
          .find((found) => found !== undefined);
      if (hit !== undefined) {
        throw new CassetteSecretError({ file: input.file, dir: input.dir, ...hit });
      }
      input.write(text);
    },
  };
}

function redacted(
  entry: CassetteEntry,
  redact: ((text: string) => string) | undefined,
): CassetteEntry {
  const body =
    entry.encoding === 'utf8' ? redactBody(entry.body, entry.headers['content-type']) : entry.body;
  if (redact === undefined) return { ...entry, body };
  return {
    ...entry,
    url: redact(entry.url),
    body: entry.encoding === 'utf8' ? redact(body) : body,
  };
}
