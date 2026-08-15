// `x docs` is the one-step answer for an agent that has a question and no filename. What is
// asserted hardest: that it answers offline from what is installed, that a question matching
// nothing is refused rather than answered plausibly, and that every answer names a real file.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { docsCommand, frameworkScopeDir } from './cmd-docs';
import type { CommandContext } from './command';
import { exec } from './exec';
import type { CommandResult, JsonValue } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: '/tmp',
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

const run = (argv: readonly string[]): Promise<CommandResult> => docsCommand.run(ctxFor(argv));

const record = (value: JsonValue | undefined): Record<string, JsonValue> => {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(true);
  return value as Record<string, JsonValue>;
};

const matchesOf = (result: CommandResult): readonly Record<string, JsonValue>[] => {
  const matches = record(result.data)['matches'];
  expect(Array.isArray(matches)).toBe(true);
  return matches as readonly Record<string, JsonValue>[];
};

describe('unit · x docs', () => {
  test('no question is refused with a runnable example, not an empty search', async () => {
    const caught: unknown = await run(['docs']).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeDefined();
    const error = caught as { code: string; fix: string };
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.fix).toContain('x docs');
  });

  test('a question about nothing in the framework does not invent an answer', async () => {
    const result = await run(['docs', 'kubernetes ingress annotation rewrite-target']);
    expect(result.ok).toBe(false);
    expect(matchesOf(result)).toEqual([]);
    // A miss still ends in something to run, per axiom 4.
    expect(record(result.data)['suggestions']).toBeDefined();
    expect(result.lines?.join('\n')).toContain('x docs');
  });
});

describe('live · x docs against the installed framework', () => {
  test('the framework scope directory resolves from the CLI itself, with no app and no network', () => {
    const scope = frameworkScopeDir();
    expect(scope).toBeDefined();
    expect(existsSync(join(scope ?? '', 'jobs/package.json'))).toBe(true);
  });

  // The acceptance test from the brief, end to end: one step, no filename known in advance.
  test('"how does job() retry" answers from @ultimat3/jobs', async () => {
    const result = await run(['docs', 'how does job() retry']);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('docs');
    const matches = matchesOf(result);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.['package']).toBe('@ultimat3/jobs');
    expect(matches.map((match) => match['topic'])).toContain('jobs.retry');
  });

  test('every match names a file that actually exists in the install', async () => {
    const scope = frameworkScopeDir() ?? '';
    const result = await run(['docs', 'retry backoff']);
    const matches = matchesOf(result);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const dir = String(match['package']).split('/').at(-1) ?? '';
      expect(existsSync(join(scope, dir, String(match['source'])))).toBe(true);
    }
  });

  test('a conceptual question reaches prose, not just symbol names', async () => {
    const result = await run(['docs', 'why is money never a float']);
    expect(result.ok).toBe(true);
    const sources = matchesOf(result).map((match) => String(match['source']));
    expect(sources.some((source) => source.endsWith('.md'))).toBe(true);
  });

  test('an X_* code is redirected instead of ranked against prose', async () => {
    const result = await run(['docs', 'X_DB_DRIFT']);
    expect(result.lines?.join('\n')).toContain('x errors explain X_DB_DRIFT');
    // The redirect used to sit under five prose matches for "db" and "drift", which an agent
    // reads first. The code owns the answer, so the search never runs.
    expect(matchesOf(result)).toEqual([]);
    expect(record(result.data)['redirect']).toBe('X_DB_DRIFT');
  });

  test('a code that no doc mentions still gets the redirect, not the generic miss', async () => {
    const result = await run(['docs', 'X_ZZQQ_WWVV']);
    expect(result.lines?.join('\n')).toContain('x errors explain X_ZZQQ_WWVV');
    expect(record(result.data)['redirect']).toBe('X_ZZQQ_WWVV');
  });

  test('--limit caps the answer', async () => {
    const result = await run(['docs', 'job', '--limit', '2']);
    expect(matchesOf(result).length).toBe(2);
  });

  test('the answer carries the version it was read from, so a stale answer is visible', async () => {
    const result = await run(['docs', 'how does job() retry']);
    const matches = matchesOf(result);
    expect(typeof matches[0]?.['version']).toBe('string');
  });
});
