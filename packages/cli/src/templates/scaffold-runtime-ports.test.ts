// The `apps/web/runtime.ts` `x new` writes names every adapter port, typed: a row core adds reaches
// the next scaffold, and the object is checked against `RuntimeOverrides`. That the bytes typecheck
// in a generated app is scaffold-smoke's (`scaffold-typecheck.contract.test.ts`).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ADAPTER_PORTS } from '@ultimat3/core';
import { writeFiles } from '../generate-write';
import { isWired } from '../runtime-ports';
import type { GeneratedFile } from './naming';
import { entryFiles } from './scaffold-entries';
import {
  baseRuntimeSource,
  RUNTIME_MODULE,
  RUNTIME_TEST,
  runtimePortLines,
} from './scaffold-runtime-ports';
import { passwordSignInFiles } from './sign-in-password';

const runtimeSource = (): string => {
  const file = passwordSignInFiles({ locales: ['en'] }).find((f) => f.path === RUNTIME_MODULE);
  if (file === undefined || typeof file.contents !== 'string') {
    return expect.unreachable(`${RUNTIME_MODULE} is written as text`);
  }
  return file.contents;
};

describe('unit · the scaffolded runtime.ts lists every adapter port', () => {
  test('one commented line per ADAPTER_PORTS row, in table order', () => {
    const lines = runtimePortLines().split('\n');
    expect(lines).toHaveLength(ADAPTER_PORTS.length);
    ADAPTER_PORTS.forEach((row, at) => {
      expect(lines[at]).toStartWith(`  // ${row.port}: `);
      expect(lines[at]).toContain(row.interface);
    });
  });

  test('a wired line names the adapter subpath and the default; a pending one says so', () => {
    const lines = runtimePortLines().split('\n');
    const wired = ADAPTER_PORTS.findIndex((row) => isWired(row.port));
    const pending = ADAPTER_PORTS.findIndex((row) => !isWired(row.port));
    expect(lines[wired]).toContain(`${ADAPTER_PORTS[wired]?.pkg}/adapter`);
    expect(lines[wired]).toContain(`default: ${ADAPTER_PORTS[wired]?.envDefault}`);
    if (pending !== -1) expect(lines[pending]).toContain('not a runtime.ts field yet');
  });

  test('the written module is typed and carries the lines', () => {
    const source = runtimeSource();
    expect(source).toContain("import type { RuntimeOverrides } from '@ultimat3/cli/serve';");
    expect(source).toContain('} satisfies RuntimeOverrides;');
    expect(source).toContain(runtimePortLines());
  });
});

describe('unit · x new writes runtime.ts, and x g sign-in replaces it only while untouched', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const app = async (runtime: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'x-runtime-replace-'));
    dirs.push(dir);
    await Bun.write(join(dir, RUNTIME_MODULE), runtime);
    return dir;
  };
  const signInRuntime = (): GeneratedFile[] =>
    passwordSignInFiles({ locales: ['en'] }).filter((f) => f.path === RUNTIME_MODULE);

  test('the base scaffold writes the typed module with every port, and its test', () => {
    const paths = entryFiles().map((file) => file.path);
    expect(paths).toContain(RUNTIME_MODULE);
    expect(paths).toContain(RUNTIME_TEST);
    expect(baseRuntimeSource()).toContain(runtimePortLines());
    expect(baseRuntimeSource()).toContain('} satisfies RuntimeOverrides;');
  });

  test('the pristine copy is replaced without --force', async () => {
    const dir = await app(baseRuntimeSource());
    const report = await writeFiles(dir, signInRuntime(), false);
    expect(report.conflicts).toEqual([]);
    expect(await Bun.file(join(dir, RUNTIME_MODULE)).text()).toContain('assertSignInConfigured');
  });

  test("an edited copy is the author's: a conflict, never overwritten", async () => {
    const edited = baseRuntimeSource().replace('  // jobs:', '  jobs: myQueue,\n  // jobs:');
    const dir = await app(edited);
    const report = await writeFiles(dir, signInRuntime(), false);
    expect(report.conflicts.map((finding) => finding.code)).toEqual(['X_GENERATE_CONFLICT']);
    expect(await Bun.file(join(dir, RUNTIME_MODULE)).text()).toBe(edited);
  });
});
