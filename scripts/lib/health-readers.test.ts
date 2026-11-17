// The default readers of the health checkup, driven through the runner seam: the argv row 4 asks
// for is read off the stub, so a regression in the requested field set reds here, and a run that
// ended badly is judged over what the reader actually read.

import { describe, expect, test } from 'bun:test';
import { ROW_COMMANDS } from '../health';
import { narrowRuns } from './health-narrow';
import type { GhRunner } from './health-readers';
import { defaultReaders, jsonDocument, TAG_RUN_FIELDS } from './health-readers';
import { tagRunsVerdict } from './health-rule';
import type { RunResult } from './run';

const SHA = 'a'.repeat(40);
const URL = 'https://github.com/ultimate/ultimate/actions/runs/4242';

/** A runner that records the argv it was asked for and answers one document. */
const stubRunner = (document: string) => {
  const asked: string[][] = [];
  const runner: GhRunner = async (args) => {
    asked.push([...args]);
    const answer: RunResult = {
      command: ['gh', ...args],
      code: 0,
      ok: true,
      output: document,
      durationMs: 1,
      timedOut: false,
    };
    return answer;
  };
  return { asked, runner };
};

describe('unit · health-readers · the tag-runs reader', () => {
  test('it asks for exactly the fields a filing needs', async () => {
    const stub = stubRunner('[]');
    const readers = defaultReaders('.', stub.runner);
    await readers['tag-runs-ended-well']();
    expect(stub.asked.length).toBe(1);
    expect(stub.asked[0]?.join(' ')).toBe(
      `run list --workflow release-tag.yml --limit 5 --json ${TAG_RUN_FIELDS}`,
    );
    // The field list itself, read off the argv: a query that asked for less would still print the
    // command above, so the pin is on the `--json` value.
    const argv = stub.asked[0] ?? [];
    expect(argv[argv.indexOf('--json') + 1]).toBe(
      'status,conclusion,databaseId,displayTitle,headSha,url,createdAt',
    );
  });

  for (const conclusion of ['failure', 'cancelled', 'timed_out'] as const) {
    test(`a run that ended ${conclusion} carries the filing evidence`, async () => {
      const document = JSON.stringify([
        {
          databaseId: 4242,
          status: 'completed',
          conclusion,
          displayTitle: 'Tag v3.1.0',
          headSha: SHA,
          url: URL,
          createdAt: '2026-10-23T09:00:00Z',
        },
      ]);
      const stub = stubRunner(document);
      const readers = defaultReaders('.', stub.runner);
      const read = await readers['tag-runs-ended-well']();
      const verdict = tagRunsVerdict({ runs: narrowRuns(read.runs) });
      expect(verdict.verdict).toBe('unhealthy');
      expect(verdict.id).toBe(4242);
      expect(verdict.url).toBe(URL);
      expect(verdict.title).toBe('Tag v3.1.0');
      expect(verdict.createdAt).toBe('2026-10-23T09:00:00Z');
      expect(verdict.headSha).toBe(SHA);
      expect(verdict.status).toBe('completed');
      expect(verdict.conclusion).toBe(conclusion);
    });
  }
});

describe('unit · health-readers · every gh row spawns the command its refusal quotes', () => {
  // The brief's table and the refusals quote ROW_COMMANDS; a reader that spawns anything else
  // answers a query nobody can re-run. Dependabot's reader once dropped `--limit 5` this way.
  const ghOnly = [
    'tag-runs-ended-well',
    'automation-alarms',
    'dependabot-not-stuck',
    'demo-shipped',
    'tutorials-run',
    'flake-hunt',
    'bench',
    'compat',
    'private-names-secret',
    'docs-site-origin',
    'stale-bot-issues',
  ] as const;
  test.each(ghOnly)('%s', async (row) => {
    const stub = stubRunner('[]');
    await defaultReaders('.', stub.runner)[row]();
    expect(stub.asked.map((argv) => `gh ${argv.join(' ')}`).join('; ')).toBe(ROW_COMMANDS[row]);
  });
});

describe('unit · health-readers · the --json document in a child output', () => {
  // `run()` joins stderr into the output, and gh writes progress there: the document is then one
  // line among noise, and a parse over the whole join would call a present answer missing.
  test('the whole output, when it is one document', () => {
    expect(jsonDocument(' {"ok":true} \n')).toEqual({ ok: true });
  });

  test('else the LAST line that parses to an object or an array', () => {
    const output = ['{"ok":false}', 'Fetching runs…', '[1, 2]', '{broken', 'done'].join('\n');
    expect(jsonDocument(output)).toEqual([1, 2]);
  });

  test('a scalar line and noise alone are no document', () => {
    expect(jsonDocument('[ not json\nnull\nwarning: slow')).toBeUndefined();
    expect(jsonDocument('')).toBeUndefined();
  });
});
