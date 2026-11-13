#!/usr/bin/env bun
// PostToolUse(Edit|Write): `biome check --write` on the one file just edited — it formats in place
// and reports what it cannot fix. The path arrives on stdin as `tool_input.file_path`. Exit 2
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
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
    process.stderr.write(
      `${out.split('\n').slice(-30).join('\n')}\nfix what it names, then: bunx biome check --write ${file}\n`,
    );
    process.exit(2);
  }
}
