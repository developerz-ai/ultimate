// What an offline driver replays: one page, as data. The same shape whether it was written by
// hand for `fakeBrowser()` or read off disk by `fixtureBrowser()`, so a test that outgrows an
// inline fixture moves to a directory without a single edit to the run body.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';

export interface PageRecording {
  readonly url: string;
  readonly html: string;
  /**
   * `expression -> JSON`. `evaluate()` answers `unknown` on every driver, so a recording holds
   * the JSON text and the target parses it — an expression with no entry is an UNRECORDED
   * request and throws, exactly like an unrecorded navigation.
   */
  readonly evaluate?: Readonly<Record<string, string>> | undefined;
  /** `<iframe>` name or `src` -> that frame's HTML. */
  readonly frames?: Readonly<Record<string, string>> | undefined;
  /** Click-target selector -> the file that click produces, as `filename:contents`. */
  readonly downloads?: Readonly<Record<string, string>> | undefined;
  /** ISO 8601. Absent means "no age", and `fixtureBrowser({ maxAge })` cannot judge it. */
  readonly recordedAt?: string | undefined;
}

export const pageRecordingSchema: StandardSchemaV1<unknown, PageRecording> = t.object({
  url: t.string,
  html: t.string,
  evaluate: t.optional(t.record(t.string)),
  frames: t.optional(t.record(t.string)),
  downloads: t.optional(t.record(t.string)),
  recordedAt: t.optional(t.string),
}) as unknown as StandardSchemaV1<unknown, PageRecording>;

/** On-disk JSON is `unknown` and is PARSED, never cast — a fixture is somebody's edited file. */
export const parseRecording = (raw: unknown): PageRecording => parse(pageRecordingSchema, raw);

/**
 * The HTTP leg's half of the SAME fixture directory. One format covers both transports, because a
 * hybrid scrape — browser login, session handoff, HTTP bulk fetch — is only testable if the whole
 * run replays from one place. Split them across two mechanisms and the hybrid path, which is where
 * the real code lives, becomes the untestable path.
 */
export interface HttpRecording {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly recordedAt?: string | undefined;
}

export const httpRecordingSchema: StandardSchemaV1<unknown, HttpRecording> = t.object({
  url: t.string,
  method: t.string,
  status: t.number,
  body: t.string,
  headers: t.optional(t.record(t.string)),
  recordedAt: t.optional(t.string),
}) as unknown as StandardSchemaV1<unknown, HttpRecording>;

export const parseHttpRecording = (raw: unknown): HttpRecording => parse(httpRecordingSchema, raw);

/** `report.csv:a,b,c` -> the two halves. A value with no colon is all contents, no name. */
export function splitDownload(value: string): { filename: string; contents: string } {
  const colon = value.indexOf(':');
  if (colon === -1) return { filename: 'download', contents: value };
  return { filename: value.slice(0, colon), contents: value.slice(colon + 1) };
}
