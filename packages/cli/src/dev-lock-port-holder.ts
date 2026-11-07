// Who holds a taken port, as far as the OS will say: `ss`, then `lsof`, then `netstat` + `tasklist`.
// Split from `dev-lock.ts`, which re-exports it, so the lock file stays within the file ceiling.

import { exec, type Runner } from './exec';

/** Whatever is listening, as far as the OS will say. Both fields absent when it will not say. */
export interface PortHolder {
  readonly pid?: number;
  /** The process name, e.g. `bun`. Enough to recognise "that is my other project". */
  readonly command?: string;
}

/**
 * Who holds the port. `ss` first because it is present on every Linux box the framework targets and
 * needs no elevation for your own processes; `lsof` is the macOS answer; `netstat -ano` plus
 * `tasklist` the Windows one.
 *
 * Through `exec.ts`, like every other subprocess the CLI runs, so a test injects a fake `Runner`
 * rather than racing a real socket.
 *
 * EVERY PROBE IS CAUGHT SEPARATELY. `exec` refuses a missing program with `X_CLI_UNEXPECTED`, and
 * letting that escape would mean a box without `ss` gets the CLI's catch-all instead of
 * `X_PORT_IN_USE` — the exact substitution this module exists to end. A missing `ss` must fall
 * through to `lsof`, and a box with none still gets the refusal, just without a pid in it.
 */
export const portHolder = async (port: number, runner: Runner = exec): Promise<PortHolder> => {
  const probe = async (command: readonly string[]): Promise<string> => {
    try {
      const result = await runner(command, { cwd: process.cwd() });
      return result.stdout;
    } catch {
      return '';
    }
  };

  const parsed = /users:\(\("([^"]+)",pid=(\d+)/.exec(
    await probe(['ss', '-lptnH', `sport = :${port}`]),
  );
  const name = parsed?.[1];
  if (parsed !== null && name !== undefined) return { command: name, pid: Number(parsed[2]) };

  const lines = (
    await probe(['lsof', '-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpc'])
  ).split('\n');
  const pid = lines.find((line) => line.startsWith('p'))?.slice(1);
  const command = lines.find((line) => line.startsWith('c'))?.slice(1);
  if (pid !== undefined && /^\d+$/.test(pid)) {
    return command === undefined ? { pid: Number(pid) } : { command, pid: Number(pid) };
  }

  // Windows has neither: `netstat -ano` names the listening pid, `tasklist` its image.
  const listener = netstatListener(await probe(['netstat', '-ano', '-p', 'TCP']), port);
  if (listener === undefined) return {};
  const image = tasklistImage(
    await probe(['tasklist', '/FI', `PID eq ${String(listener)}`, '/FO', 'CSV', '/NH']),
  );
  return image === undefined ? { pid: listener } : { command: image, pid: listener };
};

/**
 * The pid `netstat -ano` reports LISTENING on `port`, any local address: `TCP 127.0.0.1:3000
 * 0.0.0.0:0 LISTENING 4242`, and `[::1]:3000` for IPv6. The state column is the word Windows
 * prints in English on every locale this was read on; an unrecognised line is skipped.
 */
export function netstatListener(text: string, port: number): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    const [proto, local, , state, pid] = line.trim().split(/\s+/);
    if (proto !== 'TCP' || state !== 'LISTENING' || pid === undefined || !/^\d+$/.test(pid)) {
      continue;
    }
    if (local?.endsWith(`:${String(port)}`) === true) return Number(pid);
  }
  return undefined;
}

/** The image name off `tasklist /FO CSV /NH`'s one row — `"bun.exe","4242",…` — or `undefined`. */
export function tasklistImage(text: string): string | undefined {
  const name = /^"([^"]+)","\d+"/m.exec(text.trim())?.[1];
  return name === undefined || name === '' ? undefined : name;
}
