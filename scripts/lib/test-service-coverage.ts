// Which CI part supplies a suite's service: a suite that reads a `TEST_*_URL` must be run by a
// part that starts the server behind it and exports that URL. Pure — the caller reads the tree,
// the workflow and the env file; this module only decides.

import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import { withInterpolations } from './template-interpolations';

export interface ServicePart {
  /** The matrix row's name — `live`, `unit-1`. */
  readonly part: string;
  /** The gate steps the part runs: `x verify --only <steps>`. */
  readonly only: readonly string[];
  /** The compose services the part starts. */
  readonly services: readonly string[];
  /** The `TEST_*` names the part exports into the run's environment. */
  readonly urls: readonly string[];
}

export interface ServiceSuite {
  /** Repo-relative path of the suite. */
  readonly path: string;
  /** The gate step that runs it — `ownerOf(path)`. */
  readonly step: string;
  /** The `TEST_*_URL` names it reads from the environment. */
  readonly required: readonly string[];
}

export interface CoverageGap {
  /** The suite no applicable part supplies. */
  readonly suite: string;
  /** The `TEST_*_URL` it reads and no applicable part exports. */
  readonly url: string;
}

/**
 * A read of the ambient environment and the name it reads: `Bun.env['TEST_X_URL']`,
 * `process.env['TEST_X_URL']`, `process.env.TEST_X_URL` — and nothing else. The name must start
 * `TEST_` and end `_URL`, so `DATABASE_URL` (the app's own) and `TEST_TLS_ROOT_CERT` (a file, not
 * a server) are not services.
 */
const ENV_READ =
  /\b((?:Bun|process)\.env)(?:\[\s*['"](TEST_[A-Z0-9_]*_URL)['"]\s*\]|\.(TEST_[A-Z0-9_]*_URL)\b)/g;

/**
 * A destructured read: `const { TEST_X_URL } = Bun.env` — the name sits in the PATTERN, not after
 * the env, so `ENV_READ` cannot see it and a suite that reads the service looks uncovered.
 */
const ENV_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*((?:Bun|process)\.env)\b/g;

/** The name a service URL has: `TEST_` and `_URL`, as `ENV_READ` reads them. */
const SERVICE_NAME = /^TEST_[A-Z0-9_]*_URL$/;

/**
 * The names one destructuring pattern reads: `TEST_X_URL`, `TEST_X_URL: local` and
 * `TEST_X_URL = 'default'` all read `TEST_X_URL` — the local name and the default are the
 * suite's business.
 */
function destructuredNames(pattern: string): readonly string[] {
  const names: string[] = [];
  for (const entry of pattern.split(',')) {
    const property = entry.split(':')[0];
    const name = (property?.split('=')[0] ?? '').trim();
    if (SERVICE_NAME.test(name)) names.push(name);
  }
  return names;
}

/**
 * Whether the expression ending at `end` is only WRITTEN: `Bun.env['TEST_X_URL'] = '…'`. `==`
 * and `===` compare, and `+=` reads before it writes, so neither of those is a write.
 */
function isWriteOnly(text: string, end: number): boolean {
  let at = end;
  while (at < text.length && /\s/.test(text[at] ?? '')) at += 1;
  return text[at] === '=' && text[at + 1] !== '=';
}

/**
 * The `TEST_*_URL` names a suite READS from the environment, distinct and sorted.
 *
 * Code only. A comment and a string literal are prose and fixtures, not reads — and the fixtures
 * quote the very shape this rule reads: `scripts/skip-if-cleanup.test.ts` holds whole suites'
 * source in template literals. Reading a fixture as a requirement claims a service the file never
 * reads: that changes no verdict today — the `unit` part starts Postgres and exports
 * `TEST_DATABASE_URL` (`.github/workflows/ci.yml`) — but a fixture naming a service no part
 * starts would report a gap no suite has.
 *
 * Two views, because a read's NAME lives inside a literal: `stripComments` keeps every literal's
 * text, so it names the reads; the mask says whether one is code. That mask is `maskLiterals`
 * with every template's `${…}` bodies put back (`withInterpolations`) — `maskLiterals` alone
 * blanks a template WHOLE, interpolations with it, and an interpolation is evaluated code. So a
 * read inside `${Bun.env['TEST_X_URL']}` is a read, while the same text in a template's static
 * text is a fixture.
 *
 * A READ is what a suite needs, and it has two shapes: the name after the env
 * (`Bun.env['TEST_X_URL']`) and the name in the pattern (`const { TEST_X_URL } = Bun.env`). A
 * WRITE is not a need: `Bun.env['TEST_X_URL'] = '…'` sets a fixture for a suite that never
 * dials that server, and claiming the service there fails a suite that needed no server.
 */
export function requiredServiceUrls(source: string): readonly string[] {
  const code = stripComments(source);
  const masked = withInterpolations(source, maskLiterals(source));
  const found = new Set<string>();
  for (const match of code.matchAll(ENV_READ)) {
    const whole = match[0] ?? '';
    const at = match.index;
    const prefix = match[1] ?? '';
    if (masked.slice(at, at + prefix.length) !== prefix) continue;
    if (isWriteOnly(code, at + whole.length)) continue;
    const name = match[2] ?? match[3];
    if (name !== undefined) found.add(name);
  }
  for (const match of code.matchAll(ENV_DESTRUCTURE)) {
    const whole = match[0] ?? '';
    const prefix = match[2] ?? '';
    const at = match.index + whole.length - prefix.length;
    if (masked.slice(at, at + prefix.length) !== prefix) continue;
    for (const name of destructuredNames(match[1] ?? '')) found.add(name);
  }
  return [...found].sort();
}

/**
 * One gap per suite whose required URL no applicable part supplies.
 *
 * A part applies when it runs the suite's step, and supplies when it exports the URL AND starts
 * the service behind it: a part that runs another step leaves the suite unrun, and a part that
 * exports a URL whose server it never started hands the suite a dead address.
 */
export function serviceCoverageGaps(
  suites: readonly ServiceSuite[],
  parts: readonly ServicePart[],
  serves: ReadonlyMap<string, string>,
): readonly CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const suite of suites) {
    for (const url of suite.required) {
      const service = serves.get(url);
      const supplied = parts.some(
        (part) =>
          part.only.includes(suite.step) &&
          part.urls.includes(url) &&
          service !== undefined &&
          part.services.includes(service),
      );
      if (!supplied) gaps.push({ suite: suite.path, url });
    }
  }
  return gaps;
}
