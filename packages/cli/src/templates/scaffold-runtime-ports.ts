// The commented port lines `apps/<app>/runtime.ts` is written with: one per `ADAPTER_PORTS` row,
// derived from the table, so a row core adds reaches the next scaffold with no edit here. Each line
// is the field to uncomment, the interface to implement, and the default the boot builds instead.

import { ADAPTER_PORTS } from '@ultimat3/core';
import { isWired } from '../runtime-ports';
import type { GeneratedFile } from './naming';

/** Where the generated runtime lives: `apps/<app>/runtime.ts` is what both boots read first. */
export const RUNTIME_MODULE = 'apps/web/runtime.ts';
export const RUNTIME_TEST = 'apps/web/runtime.test.ts';

/** What the header of every generated `runtime.ts` says, whichever generator wrote it. */
export const RUNTIME_HEADER = `// What this app hands the framework's boot — \`x dev\` and the container both import it before a
// port is bound. The ONE place a backend is swapped: uncomment a port, hand it your adapter (the
// interface is on its package's \`/adapter\` subpath, its conformance suite in @ultimat3/testing).
// This file runs BEFORE its own ports are installed: import no app module that seals a secret or
// builds auth at module scope — it would run on the default clock and secret source.`;

/** The camel-cased value name a line suggests (`JobDriver` → `myJobDriver`). */
const valueName = (iface: string): string => `my${iface}`;

/**
 * Every row as a comment. A wired row is a `RuntimeOverrides` field — uncommented it typechecks
 * against the interface it names. A pending row says so, because uncommenting it is TS2353 until
 * the boot honours it (`runtime-port-bindings.ts`).
 */
export function runtimePortLines(indent = '  '): string {
  return ADAPTER_PORTS.map((row) => {
    const port = row.port;
    const where = `${row.interface} from '${row.pkg}/adapter'; default: ${row.envDefault}`;
    return isWired(port)
      ? `${indent}// ${port}: ${valueName(row.interface)}, // ${where}`
      : `${indent}// ${port}: not a runtime.ts field yet (${row.interface}, ${row.pkg})`;
  }).join('\n');
}

/** `x new`'s `runtime.ts`: no routes, no guard — every port commented, the object typed. */
export const baseRuntimeSource = (): string => `${RUNTIME_HEADER}
import type { RuntimeOverrides } from '@ultimat3/cli/serve';

export const runtime = {
${runtimePortLines()}
} satisfies RuntimeOverrides;
`;

/** Its test: the module loads, and names no port until the author uncomments one. */
export const baseRuntimeTest =
  (): string => `// The runtime loads under test, and swaps nothing until a port is uncommented.
import { expect, unitTest } from '@ultimat3/testing';
import { runtime } from './runtime';

unitTest('the runtime loads', () => {
  expect(runtime).toEqual({});
});
`;

/** The pair `x new` writes; `x g sign-in` replaces both while they are still these bytes. */
export const baseRuntimeFiles = (): readonly GeneratedFile[] => [
  { path: RUNTIME_MODULE, contents: baseRuntimeSource() },
  { path: RUNTIME_TEST, contents: baseRuntimeTest() },
];
