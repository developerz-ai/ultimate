#!/usr/bin/env bun
// Enforce that every `@ultimat3/core` export that THROWS has a non-test caller — in shipped
// framework source or in a tracked app. `declaration-readers.ts` asks "is this key read?"; this is
// the same question of a function: is anything there to receive the coded error it raises?
//
// WHY IT EXISTS. `assertEnvExample` threw `X_ENV_EXAMPLE_DRIFT`, was public, documented and tested,
// and nothing called it: `x verify`'s `manifest` step built its own finding byte-for-byte against
// `renderEnvExample`. So the framework shipped two `.env.example` gates and the weaker one was the
// one in the README. `resolveSpeculation` was the same shape — a validator for "a reader outside
// `defineConfig`" that stopped existing when the CLI moved to its one loader. Both were deleted in
// 25.0.0; this is what keeps a third from shipping.
//
// WHAT COUNTS. A top-level `export function` / `export const` in `packages/core/src` (tests and
// fixtures excluded) whose body has a `throw`. A CALLER is the name as an identifier anywhere in
// `packages/*/src` or a tracked app's source, tests and fixtures excluded, with import and
// re-export statements stripped (a barrel line is not a call) and the declaration itself not
// counted. Bodies end at the next column-0 line that is not a closer — Biome's layout, which the
// lint step holds. Read through `maskLiterals`, so a name inside a string or comment is no caller.
//
// WHAT IT CANNOT SEE: a throw reached through a helper (`throw` must be in the export's own body),
// and a caller that reaches the name as `core.name`. Measured `As of 2026-10-06`: 66 throwing
// exports, 7 pinned, 0 open.
//
//   bun run scripts/declaration-readers-callers.ts [--json]

import { maskLiterals } from '../packages/core/src/source-mask';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import { GATED_APPS } from './lib/gated-apps';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'declaration-readers-callers';
export const THROWER_PINS_FILE = 'scripts/declaration-readers-callers.ts';
const CORE_SRC = 'packages/core/src/';

export interface ScannedFile {
  readonly path: string;
  /** Masked: string and comment contents blanked, offsets kept. */
  readonly text: string;
}

export interface ThrowingExport {
  readonly name: string;
  readonly at: string;
}

export interface ThrowerPin {
  /** Who calls it, or why an app is the caller the framework cannot show. Never blank. */
  readonly reason: string;
}

/**
 * The waivers: app-facing API whose caller is, by design, app code no tracked app writes yet. A row
 * names the use; a blank reason waives nothing; a row whose name gained a caller, or stopped
 * existing, is itself a finding.
 */
export const CORE_THROWER_PINS: Readonly<Record<string, ThrowerPin>> = Object.freeze({
  clientFlight: {
    reason:
      'the opt-in `flight:` an app builds from @ultimat3/core and hands rpc() / queryClient(); action and query name only its `ClientFlight` type, so a caller that never builds one pays nothing, and neither tracked app builds one yet',
  },
  notImplemented: {
    reason:
      'the one door an X_NOT_IMPLEMENTED stub goes through; zero shipped stubs is the goal (axiom 9), so its callers are a test fixture and nothing else',
  },
  parseId: { reason: 'app input boundary: validates an untrusted string into a branded Id<K>' },
  rescope: {
    reason:
      "an app's sign-in and sign-out code moves the page to the new principal (@ultimat3/core/page)",
  },
  sealedKeyId: { reason: "an app's re-seal backfill() compares a row's key id with the current" },
  useService: {
    reason: 'the read half of defineService(): app handlers resolve a late-bound service',
  },
  uuidTimestamp: { reason: 'app debugging and cursor windows over a v7 id' },
});

const isFixture = (path: string): boolean => /-fixture\.tsx?$/.test(path);
const DECLARATION = /^export (?:async )?(?:function\*? |const )([A-Za-z_$][\w$]*)/gm;
const IMPORT_OR_REEXPORT =
  /^(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*(['"])[^'"]*\1;?/gm;

/** From the declaration to the next column-0 line that is not a closer. */
function bodyAt(text: string, start: number): string {
  const lines = text.slice(start).split('\n');
  let end = 1;
  while (end < lines.length && !/^[^\s})\]]/.test(lines[end] ?? '')) end += 1;
  return lines.slice(0, end).join('\n');
}

/** Every top-level core export whose own body throws. */
export function throwingExports(files: readonly ScannedFile[]): readonly ThrowingExport[] {
  const found: ThrowingExport[] = [];
  for (const file of files) {
    if (!file.path.startsWith(CORE_SRC) || isTestPath(file.path) || isFixture(file.path)) continue;
    for (const match of file.text.matchAll(DECLARATION)) {
      const index = match.index ?? 0;
      if (!/\bthrow\b/.test(bodyAt(file.text, index))) continue;
      found.push({ name: match[1] ?? '', at: `${file.path}:${String(lineOf(file.text, index))}` });
    }
  }
  return found;
}

const referencesIn = (text: string, name: string): number =>
  [...text.matchAll(new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'g'))]
    .length;

/** How often `name` is USED across `callers`: imports, re-exports and its declaration excluded. */
export function callCount(exported: ThrowingExport, callers: readonly ScannedFile[]): number {
  const declaredIn = exported.at.slice(0, exported.at.lastIndexOf(':'));
  let count = 0;
  for (const file of callers) {
    if (isTestPath(file.path) || isFixture(file.path)) continue;
    const uses = referencesIn(file.text.replace(IMPORT_OR_REEXPORT, ''), exported.name);
    count += file.path === declaredIn ? Math.max(0, uses - 1) : uses;
  }
  return count;
}

export type ThrowerGapKind = 'uncalled' | 'stale' | 'unscanned';

export interface ThrowerGap {
  readonly kind: ThrowerGapKind;
  readonly name: string;
  readonly at?: string;
  readonly reason?: string;
}

export interface ThrowerInput {
  readonly exports: readonly ThrowingExport[];
  readonly callers: readonly ScannedFile[];
  readonly pins: Readonly<Record<string, ThrowerPin>>;
}

const pinned = (name: string, pins: Readonly<Record<string, ThrowerPin>>): boolean =>
  Object.hasOwn(pins, name) && (pins[name]?.reason ?? '').trim().length > 0;

/** The ratchet: an uncalled thrower is pinned with a reason or deleted; a stale pin goes. */
export function checkThrowers(input: ThrowerInput): readonly ThrowerGap[] {
  if (input.exports.length === 0 || input.callers.length === 0) {
    return [{ kind: 'unscanned', name: input.exports.length === 0 ? CORE_SRC : 'callers' }];
  }
  const gaps: ThrowerGap[] = [];
  const called = new Set<string>();
  for (const exported of input.exports) {
    if (callCount(exported, input.callers) > 0) called.add(exported.name);
    else if (!pinned(exported.name, input.pins)) {
      gaps.push({ kind: 'uncalled', name: exported.name, at: exported.at });
    }
  }
  const declared = new Set(input.exports.map((exported) => exported.name));
  for (const [name, pin] of Object.entries(input.pins)) {
    if (called.has(name) || !declared.has(name)) {
      gaps.push({ kind: 'stale', name, reason: pin.reason });
    }
  }
  return gaps;
}

const FINDINGS: Readonly<Record<ThrowerGapKind, (gap: ThrowerGap) => Finding>> = {
  uncalled: (gap) => ({
    code: 'X_CORE_THROWER_UNCALLED',
    cause: `${gap.name} (${gap.at ?? ''}) is a @ultimat3/core export that throws a coded error, and no non-test file in packages/*/src or a tracked app calls it — a refusal nobody receives, the shape assertEnvExample was`,
    fix: `bun run scripts/declaration-readers-callers.ts --json   # after deleting ${gap.name} and its index.ts export, calling it where it is needed, or pinning it in CORE_THROWER_PINS with the sentence naming its app-facing caller`,
    at: gap.at ?? THROWER_PINS_FILE,
  }),
  stale: (gap) => ({
    code: 'X_CORE_THROWER_PIN_STALE',
    cause: `${gap.name} is pinned as uncalled ("${gap.reason ?? ''}") and now has a caller or no longer exists — the pin would let the next uncalled thrower in beside it`,
    fix: `bun run scripts/declaration-readers-callers.ts --json   # after deleting the CORE_THROWER_PINS row for ${gap.name}`,
    at: THROWER_PINS_FILE,
  }),
  unscanned: (gap) => ({
    code: 'X_CORE_THROWERS_UNSCANNED',
    cause: `nothing was read for ${gap.name}, so every thrower reports a caller and the rule enforces nothing`,
    fix: `bun run scripts/declaration-readers-callers.ts --json   # from the repo root, where ${CORE_SRC} and the tracked apps exist`,
    at: THROWER_PINS_FILE,
  }),
};

export const throwerFindingFor = (gap: ThrowerGap): Finding =>
  Object.hasOwn(FINDINGS, gap.kind) ? FINDINGS[gap.kind](gap) : FINDINGS.unscanned(gap);

async function appSources(root: string): Promise<readonly ScannedFile[]> {
  const files: ScannedFile[] = [];
  for (const app of GATED_APPS) {
    for (const found of new Bun.Glob(`${app.dir}/**/*.{ts,tsx}`).scanSync({ cwd: root })) {
      const path = found.split('\\').join('/');
      if (/(?:^|\/)(?:node_modules|dist)\//.test(path) || isTestPath(path)) continue;
      files.push({ path, text: maskLiterals(await Bun.file(`${root}/${path}`).text()) });
    }
  }
  return files;
}

/** The tree's own answer: shipped framework source plus both tracked apps. */
export async function throwerInput(root: string): Promise<ThrowerInput> {
  const shipped = (await corpus(root, 'shipped')).map((file) => ({
    path: file.path,
    text: file.masked,
  }));
  const callers = [...shipped, ...(await appSources(root))];
  return { exports: throwingExports(shipped), callers, pins: CORE_THROWER_PINS };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const input = await throwerInput(repoRoot());
  const gaps = checkThrowers(input);
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? `${String(input.exports.length)} throwing core exports, every one called or pinned (${String(Object.keys(input.pins).length)} pinned)`
          : `${String(gaps.length)} of ${String(input.exports.length)} throwing core exports are off the ratchet`,
      findings: gaps.map(throwerFindingFor),
      data: { exports: input.exports.length, callers: input.callers.length },
    },
    args.json,
  );
}
