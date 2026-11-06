// `cassette()` — a vendor's recorded answers, replayed through `mockFetch` with the network still
// sealed, and recorded (opt-in, never under CI) with the written bytes checked for secrets. Replay
// adds no match path: each recorded URL is one `mockFetch` route, answered in call order.

// why: `cassette()` is synchronous so `await using` can hold it, so the file is read synchronously;
// Bun has no sync read or atomic rename of its own.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
// why: the cassette directory is joined from the caller's `import.meta.dir`; Bun has no path join.
import { join } from 'node:path';
import { assert } from '@ultimat3/core';
import type { UnusedEntry } from './cassette-errors';
import {
  CassetteMissingError,
  CassetteRecordRefusedError,
  CassetteUnusedError,
} from './cassette-errors';
import type { CassetteEntry } from './cassette-format';
import { decodeBody, parseCassette, urlMatch } from './cassette-format';
import { startRecording } from './cassette-record';
import { NetworkSealedError } from './errors';
import { allowHost, captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

export interface CassetteOptions {
  /** The vendor hosts a recording may reach (`api.stripe.com`). Recording needs at least one. */
  readonly record?: { readonly hosts: readonly string[] };
  /**
   * The app's rule, after the built-in masking: applied to each URL and text body before the scan.
   * Replace with `'[redacted]'` — in a URL that marker matches any one segment on replay.
   */
  readonly redact?: (text: string) => string;
  /** Values that must never be written, beside every credential-named env var's. */
  readonly secrets?: readonly string[];
}

/** `await using tape = cassette(...)`: the dispose is where a recording is written. */
export interface Cassette extends AsyncDisposable {
  readonly mode: 'replay' | 'record';
  readonly file: string;
}

/** The switch: `ULTIMATE_CASSETTE=record` records; unset (or `replay`) replays. */
export const CASSETTE_ENV = 'ULTIMATE_CASSETTE';

export function cassette(dir: string, name: string, options: CassetteOptions = {}): Cassette {
  const file = join(dir, '__cassettes__', `${name}.json`);
  const before = captureNetwork();
  const mode = modeOf(Bun.env[CASSETTE_ENV]);
  if (mode === 'record') return recording(dir, name, file, options, before.allowed);
  return replaying(dir, name, file);
}

function modeOf(value: string | undefined): Cassette['mode'] {
  if (value === undefined || value === '' || value === 'replay') return 'replay';
  assert(
    value === 'record',
    `${CASSETTE_ENV} is ${JSON.stringify(value)}; it is 'record', 'replay' or unset`,
    `${CASSETTE_ENV}=record bun test <test file>   # or unset it to replay`,
  );
  return 'record';
}

function recording(
  dir: string,
  name: string,
  file: string,
  options: CassetteOptions,
  allowedBefore: readonly string[],
): Cassette {
  // Before any dial: a gate must never reach a vendor, whatever a developer exported.
  const ci = Bun.env['CI'];
  if (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0') {
    throw new CassetteRecordRefusedError({ reason: 'ci', name });
  }
  const hosts = options.record?.hosts ?? [];
  if (hosts.length === 0) throw new CassetteRecordRefusedError({ reason: 'no-hosts', name });
  for (const host of hosts) allowHost(host);
  const tape = startRecording({
    name,
    dir,
    file,
    hosts: new Set(hosts),
    redact: options.redact,
    secrets: options.secrets ?? [],
    env: Bun.env,
    write: (text) => {
      mkdirSync(join(dir, '__cassettes__'), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, text);
      renameSync(temp, file);
    },
  });
  return {
    mode: 'record',
    file,
    async [Symbol.asyncDispose]() {
      // The unsealing ends with the recording, whatever `finish` decides.
      const now = captureNetwork();
      const added = hosts.filter((host) => !allowedBefore.includes(host));
      restoreCapturedNetwork({ ...now, allowed: now.allowed.filter((h) => !added.includes(h)) });
      await tape.finish();
    },
  };
}

interface Queue {
  readonly entries: CassetteEntry[];
  readonly used: boolean[];
  next: number;
}

function replaying(dir: string, name: string, file: string): Cassette {
  if (!existsSync(file)) throw new CassetteMissingError({ file, dir, name });
  const { entries } = parseCassette(readFileSync(file, 'utf8'), file);
  // URL first, then verb: one route per URL, so a masked query's pattern is registered once.
  const byUrl = new Map<string, Map<string, Queue>>();
  for (const entry of entries) {
    const verbs = byUrl.get(entry.url) ?? new Map<string, Queue>();
    byUrl.set(entry.url, verbs);
    const queue = verbs.get(entry.method) ?? { entries: [], used: [], next: 0 };
    verbs.set(entry.method, queue);
    queue.entries.push(entry);
    queue.used.push(false);
  }
  const before = captureNetwork().mocks.length;
  for (const [url, verbs] of byUrl) mockFetch(urlMatch(url), (request) => answer(verbs, request));
  // `mockFetch` puts each new route FIRST: the cassette's are the head of the list.
  const registered = captureNetwork().mocks;
  const routes = registered.slice(0, registered.length - before);
  return {
    mode: 'replay',
    file,
    async [Symbol.asyncDispose]() {
      const now = captureNetwork();
      restoreCapturedNetwork({ ...now, mocks: now.mocks.filter((r) => !routes.includes(r)) });
      const unused: UnusedEntry[] = [];
      for (const [url, verbs] of byUrl) {
        for (const [method, queue] of verbs) {
          queue.used.forEach((used, index) => {
            if (!used) unused.push({ method, url, index });
          });
        }
      }
      if (unused.length > 0) throw new CassetteUnusedError({ file, dir, unused });
    },
  };
}

/** The next recorded answer for this verb; past the end the last repeats, as `mockFetch`'s do. */
function answer(verbs: ReadonlyMap<string, Queue>, request: Request): Response {
  const queue = verbs.get(request.method.toUpperCase());
  if (queue === undefined) {
    throw new NetworkSealedError({ url: request.url, method: request.method, allowed: [] });
  }
  const index = Math.min(queue.next, queue.entries.length - 1);
  queue.next += 1;
  queue.used[index] = true;
  const entry = queue.entries[index];
  if (entry === undefined) {
    throw new NetworkSealedError({ url: request.url, method: request.method, allowed: [] });
  }
  const empty = [101, 204, 205, 304].includes(entry.status);
  return new Response(empty ? null : decodeBody(entry), {
    status: entry.status,
    headers: entry.headers,
  });
}
