// The 26.0.0 verbs (#709): `ls`, `rm` and `describe` are refused by the parser on every command
// that used them, never aliased — and the refusal's fix names the one verb that replaced each.

import { describe, expect, test } from 'bun:test';
import { jobsSpec } from './cmd-jobs-spec';
import { actionsSpec, entitiesSpec, queriesSpec } from './cmd-registries-spec';
import { parseArgs, RETIRED_VERBS, retiredVerbReplacement } from './parse';

const SPECS = [jobsSpec, actionsSpec, queriesSpec, entitiesSpec];

const refusal = (argv: readonly string[]): { code: string; fix: string } => {
  try {
    parseArgs([...argv], SPECS);
  } catch (error) {
    return error as { code: string; fix: string };
  }
  return expect.unreachable(`x ${argv.join(' ')} parsed`);
};

describe('unit · one verb each, no alias', () => {
  test.each([
    [['jobs', 'ls'], 'x jobs list'],
    [['jobs', 'rm', '019ff1c5-0000-7000-8000-000000000001'], 'x jobs delete'],
    [['actions', 'describe', 'publishPost'], 'x actions show'],
    [['queries', 'describe', 'feed'], 'x queries show'],
    [['entities', 'describe', 'posts'], 'x entities show'],
  ])('x %p is refused, and the fix names the verb that replaced it', (argv, fix) => {
    const error = refusal(argv);
    expect(error.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(error.fix).toBe(fix);
  });

  test('the replacements parse', () => {
    expect(parseArgs(['jobs', 'list'], SPECS).subcommand).toBe('list');
    expect(parseArgs(['jobs', 'delete', 'id'], SPECS).subcommand).toBe('delete');
    expect(parseArgs(['actions', 'show', 'publishPost'], SPECS).subcommand).toBe('show');
  });

  test('no spec declares a retired verb as a subcommand', () => {
    for (const spec of SPECS) {
      for (const retired of Object.keys(RETIRED_VERBS)) {
        expect(spec.subcommands ?? []).not.toContain(retired);
      }
    }
  });

  test('a replacement is named only where the command has it', () => {
    expect(retiredVerbReplacement('rm', ['list', 'delete'])).toBe('delete');
    expect(retiredVerbReplacement('rm', ['list', 'show'])).toBeUndefined();
    expect(retiredVerbReplacement('toString', ['toString'])).toBeUndefined();
  });
});
