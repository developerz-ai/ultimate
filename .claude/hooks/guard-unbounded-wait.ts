#!/usr/bin/env bun
// PreToolUse(Bash): refuse a `while`/`until` polling loop that sleeps with no bound. An agent's
// waiter outlives its report when the thing it waits on never comes (sweep 7: three such loops ran
// two hours after their worker finished). Exit 2 blocks with the bounded spelling.

/** A polling loop's head: the keyword in command position, then its condition up to `do`. */
const LOOP_HEAD = /(?:^|[;&|(\n]|\bdo\b|\bthen\b|\belse\b)\s*(?:while|until)\s([\s\S]*?)\bdo\b/g;

/** A heredoc: its body is data, unless the program it feeds is a shell, which runs it. */
const HEREDOC =
  /([^\n]*?)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*(?=\n|$)/g;
const FEEDS_A_SHELL = /(?:^|[\s;&|(])(?:ba|z|da|k)?sh(?:\s+-[a-z]+)*\s*$/;

/** A condition that reads a clock or a counter ends on its own; nothing else in the loop counts. */
const BOUNDED_CONDITION =
  /\$SECONDS\b|\bdeadline\b|\$\(\s*date\b|\(\([^)]*(?:<|>)|\s-(?:lt|le|gt|ge)\s/i;

/** The command as a shell sees it: a heredoc fed to anything but a shell is blanked out. */
const shellText = (command: string): string =>
  command.replace(
    HEREDOC,
    (_whole: string, before: string, _q: string, _tag: string, body: string) =>
      FEEDS_A_SHELL.test(before) ? `${before}\n${body}\n` : `${before}\n`,
  );

/** True when the command polls in a loop that nothing bounds. */
export function unboundedWait(command: string): boolean {
  const shell = shellText(command);
  for (const loop of shell.matchAll(LOOP_HEAD)) {
    const at = loop.index ?? 0;
    const body = shell.slice(
      at,
      shell.indexOf('done', at) === -1 ? undefined : shell.indexOf('done', at),
    );
    if (!/\bsleep\b/.test(body)) continue;
    // `timeout N` before the loop bounds everything after it: the whole command, or its `bash -c`.
    if (/(?:^|[\s;&|(])timeout\s+(?:-[a-zA-Z]+\s+(?:\S+\s+)?)*\d+[smh]?\s/.test(shell.slice(0, at)))
      continue;
    if (BOUNDED_CONDITION.test(loop[1] ?? '')) continue;
    return true;
  }
  return false;
}

if (import.meta.main) {
  const input: unknown = JSON.parse((await Bun.stdin.text()) || '{}');
  const record = (typeof input === 'object' && input !== null ? input : {}) as {
    tool_input?: { command?: unknown };
  };
  const command = typeof record.tool_input?.command === 'string' ? record.tool_input.command : '';
  if (unboundedWait(command)) {
    process.stderr.write(
      "BLOCKED by .claude/hooks/guard-unbounded-wait.ts: a polling loop with no bound outlives the agent that started it when the thing it waits on never comes. Run it under a deadline: timeout 900 bash -c 'until <condition>; do sleep 10; done' — or count the polls (for i in $(seq 1 90); do <condition> && break; sleep 10; done)\n",
    );
    process.exit(2);
  }
}
