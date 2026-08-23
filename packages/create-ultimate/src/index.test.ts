import { describe, expect, test } from 'bun:test';
import { createApp } from './index';

const capture = async (argv: readonly string[]): Promise<{ code: number; out: string }> => {
  const lines: string[] = [];
  const code = await createApp({
    argv,
    cwd: process.cwd(),
    write: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
};

describe('unit · create-ultimate', () => {
  test('delegates to `x new` and plans the monorepo without writing anything', async () => {
    const { code, out } = await capture(['demo-app', '--dry-run', '--json']);
    expect(code).toBe(0);
    const payload = JSON.parse(out) as { ok: boolean; command: string; data: { files: string[] } };
    expect(payload.command).toBe('new');
    expect(payload.data.files).toContain('app.config.ts');
    expect(payload.data.files).toContain('apps/web/site/page.tsx');
  });

  // The fix line is a command the reader is meant to RUN, and this package's whole reason to exist
  // is running before `x` does. `x new myapp` was an instruction nobody in this process could
  // follow: the binary it names is the one they have not installed yet.
  test('a missing name is fixed by the command the caller actually typed', async () => {
    const { code, out } = await capture(['--json']);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { findings: { code: string; fix: string }[] };
    expect(payload.findings[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(payload.findings[0]?.fix).toBe('bunx create-ultimate myapp');
  });

  test('a path where a name goes names the same invocation', async () => {
    const { code, out } = await capture(['/srv/apps/shop', '--json']);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { findings: { code: string; fix: string }[] };
    expect(payload.findings[0]?.fix).toBe('bunx create-ultimate shop --dir /srv/apps');
  });
});
