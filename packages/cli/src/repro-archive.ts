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
  'the error code, cause and stack frames, the test that replays it (reproducer), and the failing call',
  '(subject): its keys and ids as they were; every other input, row and step value a [redacted] stand-in',
  'the replay fills, the actor org a placeholder. With --include-rows those values are real: read them.',
  'Always masked: secret-named keys, .sensitive() fields, sealed columns. Replaced: the app root (.), home',
  '(~), secret-named / URL / dotenv env values ([env:NAME]), config and env-URL hostnames ([host]), URL',
  'credentials and query values, emails ([email]), IP addresses ([ip]), other absolute paths (<abs>/file).',
  'NOT found: a value this machine never knew — a production-only secret, a customer name in a cause.',
  'Edit any value you still do not want to send. Opening a bundle never runs code from it.',
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
 * The reproducer, rendered from a subject alone — never from a bundle's own `reproducer` text,
 * which a stranger could have written — against the scaffold's API index and `dbPackage` (the
 * placeholder in a bundle; the scratch app's own when `create-ultimate repro` opens one).
 */
export function bundleReproducer(
  subject: ReproSubject,
  dbPackage: string = PLACEHOLDER_DB_MODULE,
): { file: string; source: string[] } {
  const id = subjectIdOf(subject);
  const imports = [`../${API_INDEX.replace(/\/index\.ts$/, '')}`];
  const source =
    subject.kind === 'job'
      ? jobTestSource(subject.failure, { id, imports })
      : requestTestSource(subject.bundle, { id, imports, build: null, dbPackage });
  return { file: reproFile(subject), source: source.split('\n') };
}

export interface ReproArchive {
  readonly document: unknown;
  readonly scrubbed: ScrubReport;
}

/**
 * The fields the replay looks a primitive up by, kept OUT of the scrubber: a scrubbed `name` or
 * `primitive` (a dotenv value that happens to be `createPost`) is a bundle that replays nothing,
 * and none of them is data. Blanked before the scrub, put back after it.
 */
function scrubbedSubject(subject: ReproSubject, scrubber: Scrubber): ReproSubject {
  if (subject.kind === 'job') {
    const { name, code, step, jobId } = subject.failure;
    const blank = { ...subject.failure, name: '', code: null, step: null, jobId: '' };
    const clean = scrubber.value(blank) as typeof blank;
    return { kind: 'job', failure: { ...clean, name, code, step, jobId } };
  }
  const { primitive, name, code, fingerprint, id } = subject.bundle;
  const blank = { ...subject.bundle, name: '', code: '', fingerprint: '', id: '' };
  const clean = scrubber.value(blank) as typeof blank;
  return { kind: 'request', bundle: { ...clean, primitive, name, code, fingerprint, id } };
}

export function reproArchive(input: ReproArchiveInput): ReproArchive {
  const { subject, scrubber } = input;
  // The subject is scrubbed BEFORE the reproducer is rendered from it, so the test's literal holds
  // the same tokens the `subject` section does; the reproducer is then never scrubbed again — its
  // import lines are the scratch app's, and nothing in it came from anywhere but the subject.
  const clean = scrubbedSubject(subject, scrubber);
  const code = clean.kind === 'job' ? clean.failure.code : clean.bundle.code;
  const data = scrubber.value({
    error: {
      cause: input.error.cause === null ? null : scrubber.location(input.error.cause),
      frames: framesOf(input.error.stack, scrubber),
    },
    schema: { entities: input.entities },
    masked: input.masked,
    dropped: input.dropped,
  }) as {
    error: { cause: string | null; frames: string[] };
    schema: unknown;
    masked: unknown;
    dropped: unknown;
  };
  const document = {
    format: BUNDLE_FORMAT,
    readFirst: READ_FIRST,
    kind: clean.kind,
    id: subjectIdOf(clean),
    code,
    fingerprint: clean.kind === 'job' ? null : clean.bundle.fingerprint,
    framework: input.framework,
    error: { code, ...data.error },
    schema: data.schema,
    masked: data.masked,
    dropped: data.dropped,
    subject: clean.kind === 'job' ? clean.failure : clean.bundle,
    reproducer: bundleReproducer(clean),
    scrubbed: scrubber.report(),
  };
  return { document, scrubbed: scrubber.report() };
}
