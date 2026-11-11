// Command-level `x doctor` result coverage: concern rules are tested beside their focused modules,
// while this file pins the stable command result and JSON data shape callers consume.

import { describe, expect, test } from 'bun:test';
// why: Bun has no synchronous temp-directory, recursive-remove or path-join primitives.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { doctorCommand } from './cmd-doctor';
import type { CommandContext } from './command';
import { parseArgs } from './parse';

const doctorContext = (cwd: string): CommandContext => ({
  args: parseArgs(['doctor', '--json'], [doctorCommand.spec]),
  cwd,
  runner: () => expect.unreachable('x doctor must not spawn a subprocess'),
  env: {},
  bunVersion: REQUIRED_BUN,
});

describe('unit · x doctor command result', () => {
  test('renders stable doctor JSON count and codes for a listener it cannot bind', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') });
    const root = doctorAppRoot();
    try {
      const port = server.port ?? expect.unreachable('Bun.serve({ port: 0 }) opened no TCP port');
      const ctx: CommandContext = {
        ...doctorContext(root),
        args: parseArgs(['doctor', '--port', String(port), '--json'], [doctorCommand.spec]),
      };
      const result = await doctorCommand.run(ctx);
      expect(result.ok).toBe(false);
      expect(result.command).toBe('doctor');
      expect(result.data).toMatchObject({
        count: (result.findings ?? []).length,
        codes: (result.findings ?? []).map((finding) => finding.code),
      });
      expect((result.data as { codes: readonly string[] }).codes).toContain('X_PORT_IN_USE');
    } finally {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function doctorAppRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-doctor-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
}
