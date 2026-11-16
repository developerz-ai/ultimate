// The unbounded-wait hook: the polling loops agents actually wrote are refused, and every bounded
// spelling its own fix offers is let through.

import { describe, expect, test } from 'bun:test';
import { unboundedWait } from './guard-unbounded-wait';

describe('unboundedWait', () => {
  test.each([
    'until ! pgrep -f "bun test ./packages/cli/e2e/sign-in.e2e.test.ts" >/dev/null; do sleep 10; done; echo done',
    'while pgrep -f verify >/dev/null; do sleep 5; done',
    'cd /repo && until gh pr checks 12 | grep -q pass; do\n  sleep 30\ndone',
  ])('refuses the loop sweep 7 left running: %s', (command) => {
    expect(unboundedWait(command)).toBe(true);
  });

  test.each([
    "timeout 900 bash -c 'until ! pgrep -f x; do sleep 10; done'",
    "timeout -k 5 600 sh -c 'while pgrep -f x; do sleep 5; done'",
    'for i in $(seq 1 90); do pgrep -f x || break; sleep 10; done',
    'end=$((SECONDS+600)); until [ $SECONDS -ge $end ] || ready; do sleep 5; done',
    'deadline=$(( $(date +%s) + 600 )); while [ $(date +%s) -lt $deadline ]; do sleep 5; done',
    'n=0; while (( n++ < 60 )); do sleep 1; done',
  ])('lets a bounded wait through: %s', (command) => {
    expect(unboundedWait(command)).toBe(false);
  });

  test.each([
    'sleep 5',
    'while read -r line; do echo "$line"; done < file',
    'bun test ./packages/core/src/errors.test.ts',
    // The false positive that shipped first: a doc edit whose heredoc describes the loop.
    "python3 - <<'EOF'\ns = 'a `while`/`until … sleep` loop; until ! pgrep x; do sleep 10; done'\nEOF\necho ok",
    'grep -n "refuses a `until ! pgrep …; do sleep 10; done` waiter" docs/history/feature-workflow.md',
  ])('ignores what is not a polling loop: %s', (command) => {
    expect(unboundedWait(command)).toBe(false);
  });
});
