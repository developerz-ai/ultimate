// Single responsibility: the JetStream API calls the bus needs — the KV bucket's stream, and the
// direct reads that answer "what is under this prefix" in one round trip. Every subject here is
// built from a validated bucket name, because a stream name goes straight into a request subject.

import { TransportProtocolError, TransportUnavailableError } from './errors';
import type { NatsClient, NatsHeaders, NatsMessage } from './nats-client';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Batch direct get and per-message TTL both landed in 2.11; without them there is no KV presence. */
const MIN_SERVER = { major: 2, minor: 11 } as const;

/** Interpolated into a stream name and a subject, so this regex is a security boundary. */
const BUCKET = /^[a-zA-Z0-9_-]+$/;

const STATUS_NOT_FOUND = 404;
const STATUS_EOB = 204;

export interface JsError {
  readonly code: number;
  readonly errCode: number;
  readonly description: string;
}

/** One direct-get hit: the KV key, its bytes, and when the server wrote it. */
export interface KvRecord {
  readonly key: string;
  readonly value: string;
  /** The server's own write time — the one clock every node agrees on. */
  readonly writtenAt: number | undefined;
  /** `DEL`/`PURGE` marks a tombstone; a live value has none. */
  readonly operation: string | undefined;
}

export function assertBucket(bucket: string): void {
  if (!BUCKET.test(bucket)) {
    throw new TransportProtocolError({
      transport: 'nats',
      stage: 'bucket',
      detail: `"${bucket}" is not a bucket name: letters, digits, "-" and "_" only`,
      fix: 'set NATS_KV_BUCKET to a name matching [a-zA-Z0-9_-]+, then restart',
    });
  }
}

/** `2.11.17` → `{ major: 2, minor: 11 }`. A version we cannot read is treated as too old. */
export function assertServerVersion(version: string): void {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (major > MIN_SERVER.major || (major === MIN_SERVER.major && minor >= MIN_SERVER.minor)) return;
  throw new TransportProtocolError({
    transport: 'nats',
    stage: 'jetstream',
    detail: `nats-server ${version || '<unknown>'} is older than ${MIN_SERVER.major}.${MIN_SERVER.minor}, which is where batch direct get and per-message TTL landed`,
    fix: `run nats:${MIN_SERVER.major}.${MIN_SERVER.minor}-alpine or newer with JetStream enabled (\`nats-server -js\`)`,
  });
}

const asObject = (message: NatsMessage, subject: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(message.payload));
  } catch {
    throw new TransportProtocolError({
      transport: 'nats',
      stage: 'jetstream',
      detail: `${subject} answered with something that is not json`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TransportProtocolError({
      transport: 'nats',
      stage: 'jetstream',
      detail: `${subject} answered with a ${Array.isArray(parsed) ? 'list' : typeof parsed}`,
    });
  }
  return parsed as Record<string, unknown>;
};

const errorOf = (body: Record<string, unknown>): JsError | undefined => {
  const raw = body['error'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  return {
    code: typeof fields['code'] === 'number' ? fields['code'] : 0,
    errCode: typeof fields['err_code'] === 'number' ? fields['err_code'] : 0,
    description: typeof fields['description'] === 'string' ? fields['description'] : 'unknown',
  };
};

/** One JetStream API call. The API always answers with json, and reports failure inside it. */
export async function jsRequest(
  client: NatsClient,
  subject: string,
  body: unknown,
): Promise<{ readonly data: Record<string, unknown>; readonly error: JsError | undefined }> {
  const reply = await client.request(subject, encoder.encode(JSON.stringify(body ?? {})));
  const data = asObject(reply, subject);
  return { data, error: errorOf(data) };
}

/** `jsRequest`, but a JetStream error is thrown rather than returned. */
export async function jsCall(
  client: NatsClient,
  subject: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const { data, error } = await jsRequest(client, subject, body);
  if (error === undefined) return data;
  throw new TransportUnavailableError({
    transport: 'nats',
    reason: `${subject} failed: ${error.description} (code ${error.code}/${error.errCode})`,
  });
}

export const kvStream = (bucket: string): string => `KV_${bucket}`;
export const kvSubject = (bucket: string, key: string): string => `$KV.${bucket}.${key}`;

/**
 * Create the bucket's stream when it is missing, and leave an existing one alone. Doing it here
 * rather than in an ops runbook is what lets `x dev` and a fresh cluster boot the same way.
 */
export async function ensureKvBucket(
  client: NatsClient,
  bucket: string,
  ttlMs: number,
): Promise<void> {
  assertBucket(bucket);
  assertServerVersion(client.version);
  const stream = kvStream(bucket);
  const info = await jsRequest(client, `$JS.API.STREAM.INFO.${stream}`, {});
  if (info.error === undefined) return;
  if (info.error.code !== STATUS_NOT_FOUND) {
    throw new TransportUnavailableError({
      transport: 'nats',
      reason: `could not read stream ${stream}: ${info.error.description}`,
    });
  }
  await jsCall(client, `$JS.API.STREAM.CREATE.${stream}`, {
    name: stream,
    subjects: [`$KV.${bucket}.>`],
    // History of one: presence is a current value, never a log. `discard: new` keeps a full
    // bucket from silently dropping the oldest member instead of refusing the newest write.
    max_msgs_per_subject: 1,
    discard: 'new',
    deny_delete: true,
    allow_direct: true,
    allow_rollup_hdrs: true,
    allow_msg_ttl: true,
    // A whole-stream ceiling as well as the per-message TTL: a node that dies mid-put must not be
    // able to leave a member behind forever, whatever happens to its heartbeats.
    max_age: Math.max(ttlMs, 60_000) * 1_000_000,
    storage: 'file',
    num_replicas: 1,
  });
}

const recordOf = (message: NatsMessage, bucket: string): KvRecord | undefined => {
  const subject = message.header('Nats-Subject');
  if (subject === undefined) return undefined;
  const stamp = message.header('Nats-Time-Stamp');
  const writtenAt = stamp === undefined ? undefined : Date.parse(stamp);
  return {
    key: subject.slice(`$KV.${bucket}.`.length),
    value: decoder.decode(message.payload),
    writtenAt: writtenAt === undefined || Number.isNaN(writtenAt) ? undefined : writtenAt,
    operation: message.header('KV-Operation'),
  };
};

/** The current value for one key, or `undefined` when the server has none. */
export async function kvGet(
  client: NatsClient,
  bucket: string,
  key: string,
): Promise<KvRecord | undefined> {
  const subject = `$JS.API.DIRECT.GET.${kvStream(bucket)}.${kvSubject(bucket, key)}`;
  const reply = await client.request(subject, new Uint8Array(0));
  if (reply.status === STATUS_NOT_FOUND) return undefined;
  return recordOf(reply, bucket);
}

/**
 * Every current value under a wildcard. A batch direct read answers at most `batch` messages and
 * then an empty `204 EOB`; a range nobody has written answers `404` and nothing else.
 *
 * PAGED, on the last sequence read, and by `next_by_subj` rather than `multi_last`. It was one
 * `multi_last` batch, and that fails twice past 1,000 members: the batch truncated the set — and
 * `sweep()`, which differences the full set, announced a `leave` for every member past the cut —
 * and a real nats-server (2.11, measured) refuses a `multi_last` matching more than 1,024 subjects
 * outright with `413 Too Many Results`, which the old loop skipped as a marker and returned an
 * EMPTY set. The bucket keeps one message per subject (`max_msgs_per_subject: 1`), so walking every
 * message under the filter IS the last value per key. A page shorter than `batch` is the last.
 */
export async function kvLast(
  client: NatsClient,
  bucket: string,
  filter: string,
  batch = 1_000,
): Promise<readonly KvRecord[]> {
  const subject = `$JS.API.DIRECT.GET.${kvStream(bucket)}`;
  const byKey = new Map<string, KvRecord>();
  let from = 1;
  for (;;) {
    const body = { seq: from, next_by_subj: kvSubject(bucket, filter), batch };
    const replies = await client.requestMany(subject, encoder.encode(JSON.stringify(body)), {
      until: (message) => message.status === STATUS_EOB || message.status === STATUS_NOT_FOUND,
    });
    let last = 0;
    let read = 0;
    for (const reply of replies) {
      // The terminators are filtered by `until`. Any OTHER status — a `408` timeout, a `503` — is
      // a batch that did not finish, and reading it as the whole set is the truncation above.
      if (reply.status !== 0) {
        throw new TransportUnavailableError({
          transport: 'nats',
          reason: `${subject} answered status ${reply.status} mid-batch, so the set read was incomplete`,
        });
      }
      read += 1;
      const seq = Number.parseInt(reply.header('Nats-Sequence') ?? '', 10);
      if (Number.isSafeInteger(seq) && seq > last) last = seq;
      const record = recordOf(reply, bucket);
      if (record) byKey.set(record.key, record);
    }
    if (read < batch || last === 0) return [...byKey.values()];
    from = last + 1;
  }
}

/** A KV write is a publish that waits for JetStream's ack — a lost put must not read as stored. */
export async function kvWrite(
  client: NatsClient,
  bucket: string,
  key: string,
  value: string,
  headers: NatsHeaders,
): Promise<void> {
  const subject = kvSubject(bucket, key);
  const reply = await client.request(subject, encoder.encode(value), { headers });
  const body = asObject(reply, subject);
  const error = errorOf(body);
  if (error !== undefined) {
    throw new TransportUnavailableError({
      transport: 'nats',
      reason: `${subject} was not stored: ${error.description} (code ${error.code})`,
    });
  }
}
