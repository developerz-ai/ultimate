// The one hook `x new` writes: `.claude/hooks/format-edited.ts`, run after every Edit/Write. A
// Bun script rather than a shell one-liner, because the edited path arrives as JSON on stdin
// (`tool_input.file_path`) — the harness sets no `$CLAUDE_FILE_PATHS` — and `jq` is not a
// dependency a fresh app (or a Windows machine) can be assumed to have.

import type { GeneratedFile } from './naming';

export const HOOK_PATH = '.claude/hooks/format-edited.ts';

/** The settings.json command line that runs it, from wherever the session's cwd is. */
export const HOOK_COMMAND = `bun "$CLAUDE_PROJECT_DIR"/${HOOK_PATH}`;

const script = `#!/usr/bin/env bun
// PostToolUse(Edit|Write): \`biome check --write\` on the one file just edited — it formats in place
// and reports what it cannot fix. The path arrives on stdin as \`tool_input.file_path\`. Exit 2
// shows the agent the finding (the edit already landed); a file biome does not handle is a no-op.

const input: unknown = JSON.parse((await Bun.stdin.text()) || '{}');
const record = (typeof input === 'object' && input !== null ? input : {}) as {
  tool_input?: { file_path?: unknown };
};
const file = record.tool_input?.file_path;
if (typeof file === 'string' && file !== '') {
  const proc = Bun.spawnSync(
    ['bunx', 'biome', 'check', '--write', '--no-errors-on-unmatched', file],
    { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 },
  );
  if (proc.exitCode !== 0) {
    const out = \`\${proc.stdout.toString()}\${proc.stderr.toString()}\`.trim();
    process.stderr.write(
      \`\${out.split('\\n').slice(-30).join('\\n')}\\nfix what it names, then: bunx biome check --write \${file}\\n\`,
    );
    process.exit(2);
  }
}
`;

export function claudeHookFile(): GeneratedFile {
  return { path: HOOK_PATH, contents: script };
}
