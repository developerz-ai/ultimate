// `instrument-slots`: an exported observer slot reds, in either export spelling; an allowed port
// passes; a stale allowance reds; a string or comment naming a slot is not a slot.

import { describe, expect, test } from 'bun:test';
import { maskLiterals } from '../packages/core/src/source-mask';
import { INSTRUMENT_SLOT_ALLOWED, instrumentSlotResult, instrumentSlots } from './instrument-slots';

const file = (path: string, source: string) => ({ path, masked: maskLiterals(source) });

/** A fixture allowance: the repo's own table is empty, and the mechanism is judged on this one. */
const ALLOWED = Object.freeze<Record<string, string>>({
  'packages/core/src/sink.ts#setFooSink':
    'a fixture test seam that decides WHERE a line goes; the tee is on the bus',
});

/** The allowed rows, present, so a fixture is judged on its own slots alone. */
const ALLOWED_FILES = Object.keys(ALLOWED).map((row) => {
  const [path, name] = row.split('#');
  return file(path ?? '', `export function ${name}(next: unknown): void {}\n`);
});

const codesOf = (files: ReturnType<typeof file>[]): readonly string[] =>
  (instrumentSlotResult([...ALLOWED_FILES, ...files], ALLOWED).findings ?? []).map(
    (one) => one.code,
  );

describe('instrument-slots', () => {
  test('a fixture exporting setFooObserver reds, with the line', () => {
    const slots = instrumentSlots(
      'packages/foo/src/observe.ts',
      maskLiterals('// header\nexport function setFooObserver(next: unknown): void {}\n'),
    );
    expect(slots).toEqual([
      { file: 'packages/foo/src/observe.ts', line: 2, name: 'setFooObserver', via: 'declared' },
    ]);
    expect(
      codesOf([file('packages/foo/src/observe.ts', 'export function setFooObserver() {}')]),
    ).toEqual(['X_INSTRUMENT_SLOT_FORBIDDEN']);
  });

  test('every spelling of a slot is one: const, sink, exporter, ring buffer, export list', () => {
    const source = [
      'export const setDecisionSink = (next: unknown): void => {};',
      'export async function setSpanExporter() {}',
      'export function recentInvalidations() { return []; }',
      'function setQuietObserver() {}',
      'export { setQuietObserver };',
      "export { install as setLoudObserver } from './x';",
    ].join('\n');
    expect(
      instrumentSlots('packages/foo/src/x.ts', maskLiterals(source)).map((s) => s.name),
    ).toEqual([
      'setDecisionSink',
      'setSpanExporter',
      'recentInvalidations',
      'setQuietObserver',
      'setLoudObserver',
    ]);
  });

  test('a subscriber, an unexported setter, a string and a comment are not slots', () => {
    const source = [
      "export function subscribeRows() { return subscribe('entity.row', () => {}); }",
      'function setLocalSink() {}',
      "const hint = 'export function setFooObserver() {}';",
      '// export function setBarObserver() {}',
      'export function setDbClient() {}',
      'export function settleObserver() {}',
    ].join('\n');
    expect(instrumentSlots('packages/foo/src/x.ts', maskLiterals(source))).toEqual([]);
  });

  test('an allowed port passes; its row gone stale reds', () => {
    expect(codesOf([])).toEqual([]);
    const without = ALLOWED_FILES.slice(1);
    const codes = (instrumentSlotResult(without, ALLOWED).findings ?? []).map((one) => one.code);
    expect(codes).toEqual(['X_INSTRUMENT_SLOT_ALLOWANCE_STALE']);
  });

  test('a barrel re-exporting an allowed slot is that slot; re-exporting a forbidden one is not', () => {
    expect(
      codesOf([file('packages/core/src/index.ts', "export { setFooSink } from './sink';")]),
    ).toEqual([]);
    expect(
      codesOf([
        file('packages/db/src/index.ts', "export { setStatementObserver } from './observe';"),
      ]),
    ).toEqual(['X_INSTRUMENT_SLOT_FORBIDDEN']);
  });

  test('an allowed name DECLARED in another file is a second slot, not the allowed one', () => {
    expect(
      codesOf([file('packages/foo/src/log.ts', 'export function setFooSink(next: unknown) {}')]),
    ).toEqual(['X_INSTRUMENT_SLOT_FORBIDDEN']);
  });

  test('every allowance names a reason', () => {
    for (const reason of Object.values({ ...INSTRUMENT_SLOT_ALLOWED, ...ALLOWED }))
      expect(reason.length).toBeGreaterThan(20);
  });
});
