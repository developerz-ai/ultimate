// Opt-in AI panes. Every claim here is a refusal: a pane is off until named, a pane with no
// runner does nothing rather than pretending, and each pane declares the narrowest scope set it
// can work in — an anomaly pane that could also read rows would be a data exfiltration surface
// with a friendly name.

import { describe, expect, test } from 'bun:test';
import {
  AI_PANES,
  type AiPane,
  type AiPaneFacts,
  type AiPaneRequest,
  type AiPaneScope,
  type AiRunner,
  aiPanes,
  runAiPane,
} from './ai-panes';
import { ADMIN_READ } from './permissions';

const FACTS: AiPaneFacts = {
  jobs: [{ name: 'sendDigest', queue: 'mail' }, { name: 'reindex' }],
  queueDepth: { mail: 12, default: 0 },
  failures: { mail: 3 },
  question: 'how many members signed up yesterday?',
};

const paneNamed = (key: string, panes: readonly AiPane[] = AI_PANES): AiPane => {
  const pane = panes.find((candidate) => candidate.key === key);
  if (pane === undefined) throw new Error(`no pane named ${key}`);
  return pane;
};

/** Records the request it was handed, so "what did the pane ask for" is assertable. */
function recordingRunner(answer = 'the answer'): AiRunner & {
  readonly seen: AiPaneRequest[];
} {
  const seen: AiPaneRequest[] = [];
  return {
    seen,
    complete(request): Promise<string> {
      seen.push(request);
      return Promise.resolve(answer);
    },
  };
}

describe('every pane ships OFF', () => {
  test('the catalog itself declares nothing enabled', () => {
    expect(AI_PANES.map((pane) => pane.key)).toEqual(['anomaly', 'nl-query', 'backlog-forecast']);
    expect(AI_PANES.every((pane) => !pane.enabled)).toBe(true);
  });

  test('aiPanes() with no options is the same list, still all off', () => {
    expect(aiPanes().map((pane) => [pane.key, pane.enabled])).toEqual([
      ['anomaly', false],
      ['nl-query', false],
      ['backlog-forecast', false],
    ]);
  });

  test('only the panes NAMED in enable come on', () => {
    const panes = aiPanes({ enable: ['nl-query'] });
    expect(panes.map((pane) => [pane.key, pane.enabled])).toEqual([
      ['anomaly', false],
      ['nl-query', true],
      ['backlog-forecast', false],
    ]);
  });

  test('an unknown key enables nothing rather than throwing or enabling all', () => {
    expect(aiPanes({ enable: ['nope'] }).every((pane) => !pane.enabled)).toBe(true);
  });

  test('enabling does not mutate the shared catalog', () => {
    aiPanes({ enable: ['anomaly', 'nl-query', 'backlog-forecast'] });
    // `AI_PANES` is module state read by every caller; a mutation here turns one host's opt-in
    // into every host's.
    expect(AI_PANES.every((pane) => !pane.enabled)).toBe(true);
  });
});

describe('each pane declares the narrowest scope it can work in', () => {
  const EXPECTED: Readonly<Record<string, readonly AiPaneScope[]>> = {
    anomaly: ['jobs:read', 'metrics:read'],
    // The DB tool this pane targets is the read-only one behind the /_x DB panel — and nothing
    // else. A pane that could also read jobs would be a wider door than the panel it fronts.
    'nl-query': ['db:read-only'],
    'backlog-forecast': ['jobs:read', 'metrics:read'],
  };

  for (const [key, scopes] of Object.entries(EXPECTED)) {
    test(`${key} declares ${scopes.join(' + ')} and needs admin:read`, () => {
      const pane = paneNamed(key);
      expect(pane.scopes).toEqual(scopes);
      expect(pane.permissions).toEqual([ADMIN_READ]);
      // The request repeats the pane's own scopes: a host checks ONE list, not two.
      expect(pane.request(FACTS).scopes).toEqual(scopes);
    });
  }

  test('no pane asks for a scope outside the declared vocabulary', () => {
    const known: readonly AiPaneScope[] = ['jobs:read', 'metrics:read', 'db:read-only'];
    for (const pane of AI_PANES) {
      for (const scope of pane.scopes) expect(known).toContain(scope);
    }
  });
});

describe('what each pane actually sends', () => {
  test('the metric panes send the counts, and never the operator’s free text', () => {
    for (const key of ['anomaly', 'backlog-forecast']) {
      const request = paneNamed(key).request(FACTS);
      expect(request.user).toContain('"mail": 12');
      expect(request.user).toContain('"mail": 3');
      // Job identity is the name and the queue — nothing that could carry a row in it.
      expect(request.user).toContain('sendDigest');
      // A queue-less job still reports a queue, so the model is not asked to infer one.
      expect(request.user).toContain('"queue": "default"');
      // The NL-query pane's question is not this pane's business.
      expect(request.user).not.toContain('signed up yesterday');
    }
  });

  test('the nl-query pane sends the question ALONE, with no metrics attached', () => {
    const request = paneNamed('nl-query').request(FACTS);
    expect(request.user).toBe('how many members signed up yesterday?');
    expect(request.system).toContain('read-only');
    expect(request.system).toContain('No DML, no DDL');
  });

  test('each pane’s system prompt is its own, so two panes cannot be confused for one', () => {
    const systems = AI_PANES.map((pane) => pane.request(FACTS).system);
    expect(new Set(systems).size).toBe(AI_PANES.length);
  });
});

describe('runAiPane refuses rather than silently doing nothing', () => {
  test('a disabled pane is a refusal, and the runner is never called', async () => {
    const runner = recordingRunner();
    const result = await runAiPane(paneNamed('anomaly'), FACTS, runner);

    expect(result).toEqual({ ok: false, reason: 'admin.ai.disabled' });
    expect(runner.seen).toEqual([]);
  });

  test('an enabled pane with no runner is a different refusal, named', async () => {
    const pane = paneNamed('anomaly', aiPanes({ enable: ['anomaly'] }));
    // Two reasons, not one: "you did not switch it on" and "you switched it on and wired
    // nothing" are different edits.
    expect(await runAiPane(pane, FACTS, undefined)).toEqual({
      ok: false,
      reason: 'admin.ai.no-runner',
    });
  });

  test('an enabled pane with a runner returns the completion, from ITS request', async () => {
    const runner = recordingRunner('mail is backed up');
    const pane = paneNamed('nl-query', aiPanes({ enable: ['nl-query'] }));

    expect(await runAiPane(pane, FACTS, runner)).toEqual({ ok: true, text: 'mail is backed up' });
    expect(runner.seen).toHaveLength(1);
    expect(runner.seen[0]?.scopes).toEqual(['db:read-only']);
    expect(runner.seen[0]?.user).toBe(FACTS.question);
  });

  test('the disabled check comes FIRST — a disabled pane with a runner still refuses', async () => {
    const runner = recordingRunner();
    const result = await runAiPane(paneNamed('nl-query'), FACTS, runner);
    expect(result).toEqual({ ok: false, reason: 'admin.ai.disabled' });
    expect(runner.seen).toEqual([]);
  });

  test('a pane that is BOTH off and unwired reports the off-ness — the edit to make first', async () => {
    // The precedence, made observable: with the two guards swapped, a host reads "wire a
    // runner" for a pane it never switched on, and wires one to no effect.
    expect(await runAiPane(paneNamed('anomaly'), FACTS, undefined)).toEqual({
      ok: false,
      reason: 'admin.ai.disabled',
    });
  });
});
