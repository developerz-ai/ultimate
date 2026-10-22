/**
 * A compacted run's handle: it carries the compacted transcript and a signed count, `.continue()`
 * resumes from it byte for byte, a continuation compacts on its own turns, and an edited count is
 * refused like any other edit.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentCompaction } from './agent';
import {
  ANSWER,
  compactedHead,
  ctx,
  declare,
  INPUT,
  pairsIntact,
  promptFor,
  READ,
  scripted,
} from './agent-compact-fixture';
import { useFixtureModels } from './model-fixture';

useFixtureModels();

const SIX_READS = [READ, READ, READ, READ, READ, READ, READ, ANSWER];
const BETTER = { call: 'respond', input: { title: 'Tides, revised' } };

describe('.continue() after a compaction', () => {
  test('the handle holds the compacted transcript and its count, and continues from it', async () => {
    const { loop } = scripted(SIX_READS);
    const write = declare({ compact: { keepTurns: 2 }, maxTurns: 20 });
    const first = await write.run(INPUT, { ctx: ctx() });
    expect(first.transcript.compacted).toBeGreaterThan(0);
    expect(compactedHead(first.transcript.messages[0])).toBe(true);
    // What the last turn sent, plus its answer: the compacted form, not the whole run.
    expect(first.transcript.messages.length).toBe((loop.at(-1)?.messages.length ?? 0) + 1);

    const again = scripted([BETTER]);
    const second = await write.continue(
      INPUT,
      { transcript: first.transcript, user: 'Revise the title.' },
      { ctx: ctx() },
    );
    expect(second.output).toEqual({ title: 'Tides, revised' });
    const sent = again.loop[0]?.messages ?? expect.unreachable('no continued request');
    // Resumed byte for byte: the compacted head and every kept turn, then the new user turn.
    expect(JSON.stringify(sent.slice(0, -1))).toBe(JSON.stringify(first.transcript.messages));
    expect(pairsIntact(sent)).toBe(true);
    expect(second.transcript.compacted).toBe(first.transcript.compacted);
    expect(second.turns).toBe(first.turns + 1);
  });

  test('a continuation that grows past the threshold compacts again, counting on from the handle', async () => {
    scripted(SIX_READS);
    const events: AgentCompaction[] = [];
    const write = declare({ compact: { keepTurns: 2 }, maxTurns: 30 }, events);
    const first = await write.run(INPUT, { ctx: ctx() });
    const before = first.transcript.compacted ?? 0;
    const again = scripted([READ, READ, READ, READ, BETTER]);
    const second = await write.continue(
      INPUT,
      { transcript: first.transcript, user: 'Read four more pages, then revise.' },
      { ctx: ctx() },
    );
    expect(again.summaries.length).toBeGreaterThan(0);
    expect(second.transcript.compacted).toBe(before + again.summaries.length);
    const done = events.filter((event) => event.outcome === 'compacted');
    expect(done.map((event) => event.compactions)).toEqual(done.map((_, index) => index + 1));
  });

  test('an edited compaction count breaks the signature', async () => {
    scripted(SIX_READS);
    const write = declare({ compact: { keepTurns: 2 } });
    const first = await write.run(INPUT, { ctx: ctx() });
    scripted([BETTER]);
    for (const compacted of [0, (first.transcript.compacted ?? 0) + 1]) {
      const edited = { ...first.transcript, compacted };
      const error = await write
        .continue(INPUT, { transcript: edited, user: 'Revise.' }, { ctx: ctx() })
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: 'X_AGENT_TRANSCRIPT_INVALID' });
    }
    const { compacted: _dropped, ...stripped } = first.transcript;
    const error = await write
      .continue(INPUT, { transcript: stripped, user: 'Revise.' }, { ctx: ctx() })
      .catch((thrown: unknown) => thrown);
    expect(String(error)).toContain('signature');
  });

  test("a compacted handle continues under compact: 'off' and keeps its count", async () => {
    scripted(SIX_READS);
    // One prompt, two declarations: a handle continues the agent its prompt names.
    const prompt = promptFor('off-later');
    const first = await declare({ compact: { keepTurns: 2 }, prompt }).run(INPUT, { ctx: ctx() });
    const again = scripted([BETTER]);
    const second = await declare({ compact: 'off', prompt }).continue(
      INPUT,
      { transcript: first.transcript, user: 'Revise.' },
      { ctx: ctx() },
    );
    expect(again.summaries).toEqual([]);
    expect(second.transcript.compacted).toBe(first.transcript.compacted);
  });
});
