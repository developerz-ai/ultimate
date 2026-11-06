// The four refusals a cassette raises: nothing to replay, a recording the code no longer drives,
// a secret about to reach disk, and a recording that must not run. Codes and titles are
// registered in ./errors; the throw sites are ./cassette and ./cassette-record.

import { renderFixLiteral, renderFixShellArg, UltimateError } from '@ultimat3/core';

/** The command that (re)records every cassette under a test directory. */
const recordCommand = (dir: string): string =>
  `ULTIMATE_CASSETTE=record bun test ${renderFixShellArg(dir, '<test dir>')}`;

export class CassetteMissingError extends UltimateError {
  constructor(input: { readonly file: string; readonly dir: string; readonly name: string }) {
    super({
      code: 'X_CASSETTE_MISSING',
      cause: `cassette ${JSON.stringify(input.name)} has no recording at ${input.file}, so there is nothing to replay`,
      fix: `${recordCommand(input.dir)}   # with cassette(import.meta.dir, ${renderFixLiteral(input.name, "'<name>'")}, { record: { hosts: ['<vendor host>'] } }), CI unset`,
      meta: { file: input.file },
    });
  }
}

export interface UnusedEntry {
  readonly method: string;
  readonly url: string;
  /** The entry's position among the recording's entries for this method and URL. */
  readonly index: number;
}

export class CassetteUnusedError extends UltimateError {
  constructor(input: {
    readonly file: string;
    readonly dir: string;
    readonly unused: readonly UnusedEntry[];
  }) {
    const first = input.unused[0];
    const named = first === undefined ? '' : `, first ${first.method} ${first.url}`;
    super({
      code: 'X_CASSETTE_UNUSED',
      cause: `${input.unused.length} recorded answer(s) in ${input.file} were never asked for${named}: the recording describes a run the code no longer makes`,
      fix: `${recordCommand(input.dir)}   # re-record — or delete the entries meta.unused names from ${input.file}`,
      meta: { file: input.file, unused: input.unused },
    });
  }
}

export class CassetteSecretError extends UltimateError {
  constructor(input: {
    readonly file: string;
    readonly dir: string;
    /** An env key, or `secrets[<i>]` for a value the cassette was handed. Never the value. */
    readonly key: string;
    readonly offset: number;
    readonly encoding: string;
  }) {
    const source = input.key.startsWith('secrets[')
      ? 'the value you passed in secrets'
      : `Bun.env[${renderFixLiteral(input.key, "'<KEY>'")}] ?? ''`;
    super({
      code: 'X_CASSETTE_SECRET',
      cause: `the value of ${input.key} (${input.encoding}) is at byte ${input.offset} of what ${input.file} would hold; nothing was written`,
      fix: `cassette(import.meta.dir, '<name>', { redact: (text) => text.replaceAll(${source}, '[redacted]') })   # covers ${input.key} at byte ${input.offset}; then ${recordCommand(input.dir)}`,
      meta: { file: input.file, key: input.key, offset: input.offset, encoding: input.encoding },
    });
  }
}

export type RecordRefusal =
  | { readonly reason: 'ci' }
  | { readonly reason: 'no-hosts' }
  | { readonly reason: 'host'; readonly host: string };

export class CassetteRecordRefusedError extends UltimateError {
  constructor(input: RecordRefusal & { readonly name: string }) {
    const name = renderFixLiteral(input.name, "'<name>'");
    const host = input.reason === 'host' ? renderFixLiteral(input.host, "'<host>'") : "'<host>'";
    const why =
      input.reason === 'ci'
        ? 'CI is set: a gate never reaches a vendor, so a recording only runs on a developer machine'
        : input.reason === 'no-hosts'
          ? 'ULTIMATE_CASSETTE=record is set but the cassette names no record.hosts to let through'
          : `the run requested ${input.host}, which record.hosts does not name`;
    super({
      code: 'X_CASSETTE_RECORD_REFUSED',
      cause: `cassette ${JSON.stringify(input.name)} refused to record: ${why}`,
      fix:
        input.reason === 'ci'
          ? 'env -u CI ULTIMATE_CASSETTE=record bun test <test file>   # on a developer machine; CI only replays'
          : `cassette(import.meta.dir, ${name}, { record: { hosts: [${host}] } })   # add the host`,
    });
  }
}
