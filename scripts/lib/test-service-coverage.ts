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
  /\b((?:Bun|process)\.env)(?:\[\s*['"](TEST_[A-Z0-9_]*_URL)['"]|\.(TEST_[A-Z0-9_]*_URL)\b)/g;

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
 */
export function requiredServiceUrls(source: string): readonly string[] {
  const code = stripComments(source);
  const masked = withInterpolations(source, maskLiterals(source));
  const found = new Set<string>();
  for (const match of code.matchAll(ENV_READ)) {
    const at = match.index;
    const prefix = match[1] ?? '';
    if (masked.slice(at, at + prefix.length) !== prefix) continue;
    const name = match[2] ?? match[3];
    if (name !== undefined) found.add(name);
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
