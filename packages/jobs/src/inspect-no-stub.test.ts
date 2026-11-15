// Holds `packages/jobs/src` at zero `NotImplementedError`: every operator verb is implemented by
// each driver that ships an operator surface, and a driver without one is refused with a jobs code
// naming the capability (`inspect-unsupported.ts`) — never an "unwritten" stub.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

const SRC = import.meta.dir;
const isSource = (path: string): boolean => !/(\.test|-fixture)\.ts$/.test(path);
/** A construction or an import — a comment that names the class for history is neither. */
const STUB = /\bnew NotImplementedError\b|\bimport\b[^;]*\bNotImplementedError\b/;

describe('@ultimat3/jobs ships no stub', () => {
  test('no source file constructs NotImplementedError', async () => {
    const scanned: string[] = [];
    const offenders: string[] = [];
    for await (const path of new Glob('**/*.ts').scan({ cwd: SRC })) {
      if (!isSource(path)) continue;
      scanned.push(path);
      if ((await Bun.file(`${SRC}/${path}`).text()).match(STUB) !== null) {
        offenders.push(path);
      }
    }
    // A scan that read nothing answers "no offenders" too: the proof it read the package.
    expect(scanned).toContain('inspect.ts');
    expect(offenders).toEqual([]);
  });
});
