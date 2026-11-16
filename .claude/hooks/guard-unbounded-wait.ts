#!/usr/bin/env bun
// PreToolUse(Bash): refuse a `while`/`until` polling loop that sleeps with no bound. An agent's
// waiter outlives its report when the thing it waits on never comes (sweep 7: three such loops ran
// two hours after their worker finished). Exit 2 blocks with the bounded spelling.

/**
 * A shell loop that polls: `while|until … do … sleep … done`, the keyword in command position.
 * Prose ABOUT such a loop (a backticked `until …` in a doc being written) is not one.
 */
const POLLING_LOOP =
  /(?:^|[;&|(\n]|\bdo\b|\bthen\b|\belse\b)\s*(?:while|until)\s[\s\S]*?\bdo\b[\s\S]*?\bsleep\b[\s\S]*?\bdone\b/;

/** A heredoc's body is data handed to a program, never shell this command runs. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?:\n|$)/g;

/** What bounds it: run under `timeout <n>`, or a condition reading a clock or a counter. */
const BOUNDED = [
  /(?:^|[\s;&|(])timeout\s+(?:-[a-zA-Z]+\s+(?:\S+\s+)?)*\d+[smh]?\s/,
  /\$SECONDS\b/,
  /\bdeadline\b/i,
  /\$\(\s*date\b/,
  /\(\(\s*[a-zA-Z_]+\s*(?:\+\+|<|-lt)/,
  /-l[te]\s+\d+/,
];

/** True when the command polls in a loop that nothing bounds. */
export function unboundedWait(command: string): boolean {
  const shell = command.replace(HEREDOC, '\n');
  if (!POLLING_LOOP.test(shell)) return false;
  return !BOUNDED.some((rule) => rule.test(shell));
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
