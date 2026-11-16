#!/usr/bin/env bun
// Enforce, as a ratchet, that a test never takes a port by probing it: bind port 0, read the port,
// release it, hand the number on. Another process can take the port in between, and on CI one did
// (`092c7cd38`: the scrape port came back as the web port; `3ea39eebb`). The safe forms are binding
// port 0 and reading the port back, or `bindFreePorts` from `@ultimat3/testing`, whose bind IS the
// proof and whose lost race is asked again. Pins: `scripts/lib/port-probe-pins.ts`.
//
//   bun run scripts/port-probe.ts [--json]
//   bun run scripts/port-probe.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import type { CorpusFile } from './lib/corpus';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { PORT_PROBE_PINS, PORT_PROBE_PINS_FILE } from './lib/port-probe-pins';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { isTestPath } from './lib/source-scan';

const SCRIPT = 'port-probe';
const EXPLAIN = 'bun run scripts/port-probe.ts --explain --json lists every one';

/** The helper's own home: the one place a port is asked of the OS and released. */
const HELPER = /^packages\/testing\/src\/free-port(?:-[\w-]+)?\.(?:test\.)?ts$/;
/** This rule's own files, which spell the shapes they refuse. */
const SELF = /^scripts\/port-probe(?:\.test)?\.ts$/;

/**
 * What a test runs: test files, fixtures, the harness package, the repo's scripts. A shipped
 * module (`x dev` choosing its own port) answers its own collision with `X_PORT_IN_USE`.
 */
export const inScope = (path: string): boolean =>
  !HELPER.test(path) &&
  !SELF.test(path) &&
  (isTestPath(path) ||
    /-fixture\.tsx?$/.test(path) ||
    path.startsWith('packages/testing/src/') ||
    path.startsWith('scripts/') ||
    /^packages\/[^/]+\/e2e\//.test(path));

/** The helper's internals, named outside it: a port probed and released by another spelling. */
const HELPER_NAME = /\bfreePort(?:ApartFrom|Pair)?\b/g;
/** `const <name> = Bun.serve(` / `Bun.listen(`: a listener the probe shape releases. */
const LISTENER = /\b(?:const|let)\s+([\w$]+)\s*=\s*Bun\.(?:serve|listen)\(/;
const PORT_ZERO = /\bport:\s*0\b/;
/** How far the release and the hand-off may sit below the bind: a probe helper is a few lines. */
const WINDOW = 10;

export interface PortProbeSite {
  readonly path: string;
  readonly line: number;
  /** `probe`: bind 0, stop, return the number. `helper`: `freePort*` outside its own file. */
  readonly form: 'probe' | 'helper';
}

/** The probe: a port-0 listener stopped, then a `return` after the stop — the number outlives it. */
function probeSites(path: string, lines: readonly string[]): PortProbeSite[] {
  const sites: PortProbeSite[] = [];
  lines.forEach((line, index) => {
    const name = LISTENER.exec(line)?.[1];
    if (name === undefined) return;
    if (!lines.slice(index, index + 4).some((near) => PORT_ZERO.test(near))) return;
    const after = lines.slice(index + 1, index + WINDOW);
    // A release deferred to a hook (`stops.push(() => server.stop())`) keeps the port held: not one.
    const release = new RegExp(`^\\s*(?:void\\s+|await\\s+)?${RegExp.escape(name)}\\.stop\\(`);
    const stop = after.findIndex((next) => release.test(next));
    if (stop < 0) return;
    if (!after.slice(stop + 1).some((next) => /^\s*(?:return\b|if\b.*\breturn\b)/.test(next))) {
      return;
    }
    sites.push({ path, line: index + 1, form: 'probe' });
  });
  return sites;
}

export function scanPortProbes(path: string, source: string): readonly PortProbeSite[] {
  if (!inScope(path) || !/freePort|port:\s*0/.test(source)) return [];
  const code = stripComments(source);
  const lines = code.split('\n');
  const helper = lines.flatMap((line, index) =>
    [...line.matchAll(HELPER_NAME)].length > 0
      ? [{ path, line: index + 1, form: 'helper' as const }]
      : [],
  );
  return [...probeSites(path, lines), ...helper].sort((a, b) => a.line - b.line);
}

export type PortProbeGap = RatchetGap<PortProbeSite>;

export const checkPortProbes = (input: {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}): readonly PortProbeGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanPortProbes(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: PortProbeSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)} (${site.form})`;

export const portProbeFindingFor = (gap: PortProbeGap): Finding =>
  gap.kind === 'over'
    ? {
        code: 'X_TEST_PORT_PROBED',
        cause: `${gap.pkg} has ${String(gap.found)} port(s) probed and released, pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — another process can take a released port before the code under test binds it`,
        fix: `bindFreePorts(async ([port]) => …)   # from @ultimat3/testing, at ${siteTarget(gap, at)}: bind the port inside it (a child: spawn and await its listen or its exit), and a port another process took is asked again — or bind port 0 and read server.port back`,
        at: leadSite(gap)?.path ?? PORT_PROBE_PINS_FILE,
      }
    : gap.kind === 'stale'
      ? {
          code: 'X_TEST_PORT_PROBE_PIN_STALE',
          cause: `${gap.pkg} is pinned at ${String(gap.pinned)} probed port(s) and has ${String(gap.found)}, so the pin would let ${String(gap.pinned - gap.found)} back in`,
          fix: `bun run scripts/port-probe.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
          at: PORT_PROBE_PINS_FILE,
        }
      : {
          code: 'X_CORPUS_UNSCANNED',
          cause:
            'no source file was read, so every package reports zero probed ports and the ratchet enforces nothing',
          fix: 'bun run scripts/port-probe.ts --explain --json   # reads nothing: the corpus scope source in scripts/lib/corpus.ts must match this repo',
          at: 'scripts/port-probe.ts',
        };

const sourceFiles = async (root: string): Promise<readonly CorpusFile[]> => corpus(root, 'source');

const treeSites = async (root: string): Promise<readonly PortProbeSite[]> =>
  (await sourceFiles(root)).flatMap((file) => scanPortProbes(file.path, file.source));

const PROBE: SiteProbe<PortProbeSite> = { rescan: scanPortProbes, line: (site) => site.line };

export const portProbeGaps = async (root: string): Promise<readonly PortProbeGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), PORT_PROBE_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const portProbeFindings = async (root: string): Promise<readonly Finding[]> =>
  (await portProbeGaps(root)).map(portProbeFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PORT_PROBE_PINS_FILE,
    pins: PORT_PROBE_PINS,
    sites: treeSites,
    findingFor: portProbeFindingFor,
    probe: PROBE,
    clean: 'no test takes a port by probing it and releasing it',
  });
}
