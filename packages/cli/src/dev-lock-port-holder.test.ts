// `portHolder`: who holds a taken port, as far as the OS will say. Split from `dev-lock.test.ts` at
// the 500-line ceiling; every probe goes through an injected runner, so no test races a socket.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { netstatListener, portHolder, tasklistImage } from './dev-lock';

/** What `exec.ts` raises when the program is not on PATH. Reproduced, never approximated. */
const missingProgram = (name: string): UltimateError =>
  new UltimateError({
    code: 'X_CLI_UNEXPECTED',
    cause: `the CLI could not run "${name}"`,
    fix: `install ${name} and put it on PATH`,
  });

describe('portHolder', () => {
  test('goes through the exec Runner, so a test never races a real socket', async () => {
    const calls: string[][] = [];
    const holder = await portHolder(3000, async (command) => {
      calls.push([...command]);
      return {
        command,
        code: 0,
        ok: true,
        stdout: 'LISTEN 0 512 *:3000 *:* users:(("bun",pid=41234,fd=11))',
        stderr: '',
        durationMs: 0,
      };
    });
    expect(holder).toEqual({ command: 'bun', pid: 41234 });
    expect(calls[0]?.[0]).toBe('ss');
  });

  test('a missing ss falls through to lsof rather than escaping as X_CLI_UNEXPECTED', async () => {
    // `exec` refuses a missing program with the CLI's catch-all. Letting that escape would replace
    // X_PORT_IN_USE with X_CLI_UNEXPECTED — the exact substitution this module exists to end.
    const holder = await portHolder(3000, async (command) => {
      // Exactly what `exec` raises for a missing program, not a bare Error: the point of the test
      // is that THIS refusal does not escape as the CLI's catch-all.
      if (command[0] === 'ss') throw missingProgram('ss');
      return {
        command,
        code: 0,
        ok: true,
        stdout: 'p41234\ncbun\n',
        stderr: '',
        durationMs: 0,
      };
    });
    expect(holder).toEqual({ command: 'bun', pid: 41234 });
  });

  test('on Windows — no ss, no lsof — netstat names the pid and tasklist its image', async () => {
    const asked: string[] = [];
    const holder = await portHolder(3000, async (command) => {
      asked.push(command[0] ?? '');
      if (command[0] === 'ss' || command[0] === 'lsof') throw missingProgram(command[0]);
      const stdout =
        command[0] === 'netstat'
          ? [
              '',
              'Active Connections',
              '',
              '  Proto  Local Address          Foreign Address        State           PID',
              '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
              '  TCP    127.0.0.1:30001        0.0.0.0:0              LISTENING       77',
              '  TCP    127.0.0.1:3000         127.0.0.1:52144        ESTABLISHED     9',
              '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       41234',
            ].join('\r\n')
          : '"bun.exe","41234","Console","1","45,312 K"\r\n';
      return { command, code: 0, ok: true, stdout, stderr: '', durationMs: 0 };
    });
    expect(holder).toEqual({ command: 'bun.exe', pid: 41234 });
    expect(asked).toEqual(['ss', 'lsof', 'netstat', 'tasklist']);
  });

  test('netstat reads IPv6 and an exact port; tasklist with no match names nothing', () => {
    expect(netstatListener('  TCP    [::1]:3000    [::]:0    LISTENING    5\r\n', 3000)).toBe(5);
    expect(netstatListener('  TCP    [::1]:30000   [::]:0    LISTENING    5\r\n', 3000)).toBe(
      undefined,
    );
    expect(tasklistImage('INFO: No tasks are running which match the specified criteria.')).toBe(
      undefined,
    );
  });

  test('neither tool available is an empty holder, never a throw', async () => {
    const holder = await portHolder(3000, async ([head]) => {
      throw missingProgram(head ?? '?');
    });
    expect(holder).toEqual({});
  });
});
