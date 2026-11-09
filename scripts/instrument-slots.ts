#!/usr/bin/env bun
// Enforce, as a build error, that every observer in the framework hangs off the ONE instrumentation
// bus (`subscribe()` in `packages/core/src/instrument.ts`): an exported `set<X>Observer`,
// `set<X>Sink` or `set<X>Exporter` slot, or a `recent<X>()` ring-buffer reader, in
// `packages/*/src` is refused.
//
// WHY A RULE. A slot holds ONE observer: the second install silently replaced the first
// (`realtime/src/live-replicator.ts` installed the row observer without chaining the previous one),
// and `db`'s statement slot was installed only by `x dev`, so production had no database spans.
// WHAT IT READS: exported declarations and `export { … }` lists in the masked text (strings and
// comments blanked). WHAT IT CANNOT SEE: a slot under another name — a floor, not a proof.
//
//   bun run scripts/instrument-slots.ts [--json]

import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'instrument-slots';

/** The bus every observer subscribes to. */
export const INSTRUMENT_BUS = 'packages/core/src/instrument.ts';

/**
 * `file#name` → why the slot is not an observer. Never a convenience row: a durable PORT (an
 * adapter that must persist, slice 21 wires it) or a test seam that decides where output goes.
 */
export const INSTRUMENT_SLOT_ALLOWED = Object.freeze<Record<string, string>>({
  'packages/core/src/audit.ts#setAuditSink':
    'a durable port, not an observer: audit rows must persist, and adapter wiring replaces the setter',
  'packages/core/src/logger.ts#setLogSink':
    'the test seam that decides WHERE a line goes instead of stdout; the tee is log.record on the bus',
});

/** A slot's shape: `set` + a capitalised subject + the role, or a `recent…` ring-buffer reader. */
export const SLOT_NAME = /^(?:set[A-Z]\w*(?:Observer|Sink|Exporter)|recent[A-Z]\w*)$/;

const DECLARED =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const LISTED = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

export interface InstrumentSlot {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** `declared` where the slot is defined; `listed` where an `export { … }` re-exports it. */
  readonly via: 'declared' | 'listed';
}

/** Every exported slot in one file — declared, or named in an `export { … }` list. */
export function instrumentSlots(path: string, masked: string): readonly InstrumentSlot[] {
  const found: InstrumentSlot[] = [];
  for (const match of masked.matchAll(DECLARED)) {
    const name = match[1] ?? '';
    if (SLOT_NAME.test(name)) {
      found.push({ file: path, line: lineOf(masked, match.index), name, via: 'declared' });
    }
  }
  for (const match of masked.matchAll(LISTED)) {
    for (const entry of (match[1] ?? '').split(',')) {
      // `export { a as setFooObserver }` exports the alias; `export { setFooObserver }` the name.
      const name =
        entry
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? '';
      if (SLOT_NAME.test(name)) {
        found.push({ file: path, line: lineOf(masked, match.index), name, via: 'listed' });
      }
    }
  }
  return found;
}

export function instrumentSlotFinding(slot: InstrumentSlot): Finding {
  return {
    code: 'X_INSTRUMENT_SLOT_FORBIDDEN',
    at: `${slot.file}:${slot.line}`,
    cause: `${slot.file}:${slot.line} exports ${slot.name}, a single observer slot; a second install replaces the first and an uninstalled one is a signal production never sees — every observer subscribes to the one bus in ${INSTRUMENT_BUS}`,
    fix: `instrument('<event>', payload);   // in ${slot.file}, in place of ${slot.name}: declare <event> in packages/core/src/instrument-events.ts, each consumer calls subscribe('<event>', handler), then: bun run scripts/instrument-slots.ts --json`,
  };
}

interface Scanned {
  readonly path: string;
  readonly masked: string;
}

export function instrumentSlotResult(files: readonly Scanned[]): ScriptResult {
  const slots = files.flatMap((file) => instrumentSlots(file.path, file.masked));
  // A re-export of an allowed slot (a barrel's `export { setLogSink }`) is the same slot.
  const allowedNames = new Set(
    Object.keys(INSTRUMENT_SLOT_ALLOWED).map((row) => row.split('#')[1]),
  );
  const allowed = (slot: InstrumentSlot): boolean =>
    Object.hasOwn(INSTRUMENT_SLOT_ALLOWED, `${slot.file}#${slot.name}`) ||
    (slot.via === 'listed' && allowedNames.has(slot.name));
  const findings: Finding[] = slots.filter((slot) => !allowed(slot)).map(instrumentSlotFinding);
  const seen = new Set(slots.map((slot) => `${slot.file}#${slot.name}`));
  for (const row of Object.keys(INSTRUMENT_SLOT_ALLOWED)) {
    if (seen.has(row)) continue;
    findings.push({
      code: 'X_INSTRUMENT_SLOT_ALLOWANCE_STALE',
      at: 'scripts/instrument-slots.ts',
      cause: `INSTRUMENT_SLOT_ALLOWED names ${row}, which no scanned file exports — the row excuses nothing, and a stale excuse is the next slot's cover`,
      fix: `bun run scripts/instrument-slots.ts --json   # after dropping or renaming the ${row} row of INSTRUMENT_SLOT_ALLOWED in scripts/instrument-slots.ts`,
    });
  }
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${files.length} files, every observer on ${INSTRUMENT_BUS}`
        : `${findings.length} instrumentation slot finding(s)`,
    findings,
    data: { files: files.length, slots },
  };
}

/** The rule as a host check, for `scripts/verify.ts`'s `boundaries` step. */
export async function instrumentSlotFindings(root: string): Promise<readonly Finding[]> {
  return instrumentSlotResult(await corpus(root, 'shipped')).findings ?? [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(instrumentSlotResult(await corpus(repoRoot(), 'shipped')), args.json);
}
