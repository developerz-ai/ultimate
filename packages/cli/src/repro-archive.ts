// Single responsibility: the repro bundle's one JSON document, assembled from parts already read —
// the redacted subject, the error, the framework versions, the touched declarations and the
// reproducer test — then passed whole through the scrubber. Pure and deterministic: no clock, no
// machine fact beyond the platform, keys in a fixed order, so two runs write the same bytes.

import type { EntityDescription } from '@ultimat3/entity';
import { API_INDEX } from './app-root';
import type { ReproSubject } from './repro-bundle';
import { jobTestSource } from './repro-job';
import { requestTestSource } from './repro-request';
import type { Scrubber, ScrubReport } from './repro-scrub';
import { reproFile } from './repro-write';
import { PLACEHOLDER_DB_MODULE } from './templates/scaffold-db-client';

/** The format tag `create-ultimate repro` checks before it opens anything. */
export const BUNDLE_FORMAT = 'x-repro-bundle/1';

/** What the bundle says about itself, first — the user reads this before sending it. */
export const READ_FIRST: readonly string[] = [
  'Read this whole file before you attach it to an issue: it is everything that leaves your machine.',
  'It holds: the installed @ultimat3/* versions, the declarations of the entities the failing call read,',
  'its input and the rows it read (secret-named keys, .sensitive() fields, sealed columns masked),',
  'the error code, cause and stack frames, and the test that replays it (reproducer).',
  'Replaced before writing: the app root (.), the home directory (~), every env value ([env:NAME]),',
  'every hostname from app.config.ts or an env URL ([host]), and other absolute paths (<abs>/file).',
  'Edit any value you still do not want to send; the reproducer reads only `subject`.',
  'A maintainer opens it with: bunx create-ultimate repro <this file>',
];

export interface ReproErrorFacts {
  readonly cause: string | null;
  readonly stack: string | null;
}

export interface FrameworkFacts {
  /** Every installed `@ultimat3/*` package, each with the versions found (more than one is a finding). */
  readonly packages: Readonly<Record<string, readonly string[]>>;
  readonly cli: string;
  readonly bun: string;
  readonly platform: string;
}

export interface ReproArchiveInput {
  readonly subject: ReproSubject;
  readonly entities: readonly EntityDescription[];
  readonly dropped: readonly string[];
  readonly masked: readonly string[];
  readonly error: ReproErrorFacts;
  readonly framework: FrameworkFacts;
  readonly scrubber: Scrubber;
}

/** The subject's own id: never the argument typed, which may be a path to a file. */
export const subjectIdOf = (subject: ReproSubject): string =>
  subject.kind === 'job' ? subject.failure.jobId : (subject.bundle.requestId ?? subject.bundle.id);

/** Where the bundle lands in the app: beside the written repro tests, named by the subject. */
export function bundleFileOf(subject: ReproSubject): string {
  const short = subjectIdOf(subject)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  return `repro/bundle-${short || 'unnamed'}.json`;
}

/** The frames of a stack — its `at …` lines, trimmed — each through `location`. */
const framesOf = (stack: string | null, scrubber: Scrubber): string[] =>
  (stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .map((line) => scrubber.location(line));

/**
 * The reproducer, written against the scratch app `create-ultimate repro` makes: the scaffold's
 * API index for registrations and the placeholder db package it renames on open.
 */
function reproducerOf(subject: ReproSubject): { file: string; source: string[] } {
  const id = subjectIdOf(subject);
  const imports = [`../${API_INDEX.replace(/\/index\.ts$/, '')}`];
  const source =
    subject.kind === 'job'
      ? jobTestSource(subject.failure, { id, imports })
      : requestTestSource(subject.bundle, {
          id,
          imports,
          build: null,
          dbPackage: PLACEHOLDER_DB_MODULE,
        });
  return { file: reproFile(subject), source: source.split('\n') };
}

export interface ReproArchive {
  readonly document: unknown;
  readonly scrubbed: ScrubReport;
}

export function reproArchive(input: ReproArchiveInput): ReproArchive {
  const { subject, scrubber } = input;
  // The subject is scrubbed BEFORE the reproducer is rendered from it, so the test's literal holds
  // the same tokens the `subject` section does.
  const clean = scrubber.value(subject) as ReproSubject;
  const draft = {
    format: BUNDLE_FORMAT,
    readFirst: READ_FIRST,
    kind: clean.kind,
    id: subjectIdOf(clean),
    code: clean.kind === 'job' ? clean.failure.code : clean.bundle.code,
    fingerprint: clean.kind === 'job' ? null : clean.bundle.fingerprint,
    framework: input.framework,
    error: {
      code: clean.kind === 'job' ? clean.failure.code : clean.bundle.code,
      cause: input.error.cause === null ? null : scrubber.location(input.error.cause),
      frames: framesOf(input.error.stack, scrubber),
    },
    schema: { entities: input.entities },
    masked: input.masked,
    dropped: input.dropped,
    subject: clean.kind === 'job' ? clean.failure : clean.bundle,
    reproducer: reproducerOf(clean),
  };
  const document = scrubber.value(draft);
  return {
    document: { ...(document as object), scrubbed: scrubber.report() },
    scrubbed: scrubber.report(),
  };
}
