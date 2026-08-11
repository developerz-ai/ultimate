#!/usr/bin/env bun

// The script catalog. An agent runs this instead of reading a list in CLAUDE.md that drifts —
// the catalog IS the directory, so a script that exists is always listed and a listed script
// always exists.
//
//   bun run scripts/help.ts [--json]

import { join } from 'node:path';
import { Glob } from 'bun';

const ROOT = join(import.meta.dir, '..');

/** First line of the file's header comment, which every script under `scripts/` must carry. */
const summaryOf = async (path: string): Promise<string> => {
  const source = await Bun.file(join(ROOT, path)).text();
  for (const line of source.split('\n')) {
    const text = line.trim();
    if (text.startsWith('#!')) continue;
    if (text.startsWith('//')) return text.replace(/^\/\/\s?/, '').trim();
    if (text !== '') break;
  }
  return '(no header comment — add one saying what this script does)';
};

export interface ScriptEntry {
  readonly command: string;
  readonly resource: string;
  readonly verb: string;
  readonly summary: string;
}

/** `scripts/<resource>/<verb>.ts` — one verb per file, so a grep for a verb finds one file. */
export const catalog = async (): Promise<readonly ScriptEntry[]> => {
  const found: ScriptEntry[] = [];
  for await (const path of new Glob('scripts/*/*.ts').scan({ cwd: ROOT })) {
    if (path.endsWith('.test.ts')) continue;
    const parts = path.split('/');
    const resource = parts[1] ?? '';
    const verb = (parts[2] ?? '').replace(/\.ts$/, '');
    found.push({ command: `bun run ${path}`, resource, verb, summary: await summaryOf(path) });
  }
  return found.sort((a, b) => a.command.localeCompare(b.command));
};

if (import.meta.main) {
  const entries = await catalog();
  if (Bun.argv.includes('--json')) {
    await Bun.stdout.write(`${JSON.stringify({ ok: true, scripts: entries }, null, 2)}\n`);
  } else {
    const width = Math.max(...entries.map((entry) => entry.command.length), 0);
    const lines = entries.map((entry) => `  ${entry.command.padEnd(width)}  ${entry.summary}`);
    await Bun.stdout.write(
      `${['scripts — one verb per file, every one takes --json', ...lines].join('\n')}\n`,
    );
  }
}
