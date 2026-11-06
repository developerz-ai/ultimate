// Single responsibility: where a repro test lands and what running it says. `<root>/repro/`, one
// file per subject — outside every surface, so it may import the app's API index for its
// registrations without crossing a boundary — and `--verify` is one `bun test` of that file.

import { existsSync } from 'node:fs'; // why: a synchronous probe of two optional app files.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isJsonObject } from '@ultimat3/core';
import { API_INDEX } from './app-root';
import type { Runner } from './exec';
import { formatWritten } from './generate-format-written';
import type { ReproSubject } from './repro-bundle';
import { jobTestSource } from './repro-job';
import { requestTestSource } from './repro-request';
import { testEnvOverrides } from './test-dotenv';

/** The directory every written repro lands in, relative to the app root. */
export const REPRO_DIR = 'repro';

/** `Received: "X_CODE: cause"` — what `expect(outcome.failure).toBeNull()` prints on a red run. */
const RECEIVED = /Received:\s*"(X_[A-Z0-9_]+)/;

/** Lower-case alphanumerics only: the id came from a person or a URL, the name is a file name. */
const shortOf = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'unnamed';

export function reproFile(subject: ReproSubject): string {
  return subject.kind === 'job'
    ? `${REPRO_DIR}/repro-${shortOf(subject.failure.jobId)}.job.test.ts`
    : `${REPRO_DIR}/repro-${shortOf(subject.bundle.requestId ?? subject.bundle.id)}.contract.test.ts`;
}

/** The app's `@<app>/db` package name, when it has one that exports the driver the code reads. */
async function dbPackageOf(root: string): Promise<string | null> {
  const path = join(root, 'packages', 'db', 'package.json');
  if (!existsSync(path)) return null;
  const parsed: unknown = await Bun.file(path).json();
  return isJsonObject(parsed) && typeof parsed['name'] === 'string' ? parsed['name'] : null;
}

/** The source a subject replays as; the API index is imported for what it registers. */
export async function reproSource(
  root: string,
  subject: ReproSubject,
  id: string,
  build: string | null,
): Promise<string> {
  const imports = existsSync(join(root, API_INDEX))
    ? [`../${API_INDEX.replace(/\/index\.ts$/, '')}`]
    : [];
  if (subject.kind === 'job') return jobTestSource(subject.failure, { id, imports });
  return requestTestSource(subject.bundle, {
    id,
    imports,
    build,
    dbPackage: await dbPackageOf(root),
  });
}

export async function writeRepro(
  root: string,
  file: string,
  source: string,
  runner: Runner,
): Promise<void> {
  await Bun.write(join(root, file), source);
  await formatWritten(root, [file], runner);
}

export interface ReproVerdict {
  readonly reproduced: boolean;
  /** The code the written test ended in, read off its output; `null` for a pass. */
  readonly got: string | null;
}

/**
 * Reproduced = the written test is RED and its output carries the captured code. A green run, or a
 * red one for another reason, is the answer `X_REPRO_NOT_REPRODUCED` reports — never a crash.
 */
export async function verifyRepro(
  root: string,
  file: string,
  expected: string | null,
  runner: Runner,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ReproVerdict> {
  // A test process, never the shell's deploy: no `DATABASE_URL` for the app's driver to follow
  // and no `ULTIMATE_ENV` to outrank `bun test`'s own — the replay runs where the app's tests run.
  const run = await runner(['bun', 'test', `./${file}`], {
    cwd: root,
    env: { ...testEnvOverrides(root, env), DATABASE_URL: undefined, ULTIMATE_ENV: undefined },
  });
  if (run.ok) return { reproduced: false, got: null };
  // The ANSWER the assertion printed — never the test's name or its source, which name the code too.
  const got = RECEIVED.exec(`${run.stdout}\n${run.stderr}`)?.[1] ?? 'a failure with no code';
  return { reproduced: expected !== null && got === expected, got };
}
