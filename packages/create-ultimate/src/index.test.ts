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

  test('a missing name fails with the exact command that fixes it', async () => {
    const { code, out } = await capture(['--json']);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { findings: { code: string; fix: string }[] };
    expect(payload.findings[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(payload.findings[0]?.fix).toBe('x new myapp');
  });
});
