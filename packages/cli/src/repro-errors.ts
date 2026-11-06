// The three ways `x repro` refuses: an id nothing holds, a capture that was never on, and a written
// test that ran and did not fail the way the original did. Registered in `error-codes.ts`.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';

export class ReproUnknownError extends UltimateError {
  constructor(input: { readonly id: string }) {
    super({
      code: 'X_REPRO_UNKNOWN',
      cause: `no dead job, captured request, trace or fingerprint matches "${input.id}"`,
      fix: 'x repro --list --json',
      meta: { id: input.id },
    });
  }
}

export class ReproCaptureOffError extends UltimateError {
  constructor(input: { readonly id: string }) {
    super({
      code: 'X_REPRO_CAPTURE_OFF',
      cause: `"${input.id}" is no job, and failureCapture is disabled in app.config.ts, so no request bundle was ever stored`,
      fix: 'x jobs list --json   # a job id replays with capture off; for requests set failureCapture: { enabled: true } in app.config.ts',
      meta: { id: input.id },
    });
  }
}

export interface NotReproducedInput {
  readonly id: string;
  readonly expected: string;
  readonly got: string | null;
  readonly masked: readonly string[];
  readonly file: string;
  readonly build: string | null;
}

export class ReproNotReproducedError extends UltimateError {
  constructor(input: NotReproducedInput) {
    const masked = input.masked.length === 0 ? 'none' : input.masked.join(', ');
    super({
      code: 'X_REPRO_NOT_REPRODUCED',
      cause: `${input.file} ended in ${input.got ?? 'a pass'}, not ${input.expected}; masked fields: ${masked}; captured on build ${input.build ?? 'unknown'}`,
      fix: `x repro ${renderFixShellArg(input.id, '<id>')} --json, then set the listed masked fields and unread rows by hand in ${renderFixShellArg(input.file, '<the written test>')}`,
      meta: { ...input },
    });
  }
}
