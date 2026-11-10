// The harness the agent-arm eval suites share: one registered agent with two real tools that count
// their runs, a gateway over a scripted model, and a baseline file on disk. Not shipped
// (`!src/**/*-fixture.ts`).

// why: Bun has no mkdtemp and no recursive remove; `removeBaselineDirs` removes what this made.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { registerAction } from '@ultimat3/action/loader';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import type { EvalBaseline } from './eval-baseline';
import { writeBaseline } from './eval-baseline';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL } from './model-fixture';
import { definePrompt } from './prompt';
import type { ScriptedTurn } from './scripted-provider';
import { scriptedProvider } from './scripted-provider';
import type { ProjectableAction } from './tools';

/** The actor id every run's `vars()` saw, in order. */
export const actorsSeen: string[] = [];

/** How often each REAL tool ran. An eval must leave both at 0. */
export const realRuns = { lookupOrder: 0, refundOrder: 0 };

const realTool = (name: keyof typeof realRuns): ProjectableAction => ({
  name,
  description: `The real ${name}`,
  mcp: { expose: true },
  run: () => {
    realRuns[name] += 1;
    return Promise.resolve({ real: true });
  },
});

/** A support agent that may look an order up and refund it. Registered, as an app's would be. */
export function declareSupport(maxTurns = 4) {
  const prompt = definePrompt<{ question: string }>({
    id: 'support.answer',
    version: '1',
    template: 'Answer through the respond tool: {{question}}',
  });
  const support = agent({
    input: t.object({ question: t.string }),
    output: t.object({ status: t.string }),
    prompt,
    vars: ({ input, ctx }) => {
      actorsSeen.push(`${ctx.actor.kind}:${ctx.actor.id}`);
      return { question: input.question };
    },
    tools: [realTool('lookupOrder'), realTool('refundOrder')],
    policy: allow(),
    maxTurns,
  });
  registerAction('supportAgent', support);
  actorsSeen.length = 0;
  realRuns.lookupOrder = 0;
  realRuns.refundOrder = 0;
  return { prompt, support };
}

/** A gateway whose model answers the scripted turns, in order, across every case of a run. */
export function scripted(...turns: readonly ScriptedTurn[]) {
  const provider = scriptedProvider({ turns });
  return {
    provider,
    gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }),
  };
}

const made: string[] = [];

/** Removes every directory `baselineFile` made. A suite that calls it does so in `afterEach`. */
export async function removeBaselineDirs(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A recorded baseline in a fresh directory; returns its path and the directory it made. */
export async function baselineFile(
  recorded: EvalBaseline | undefined,
): Promise<{ readonly path: string; readonly dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-agent-eval-'));
  made.push(dir);
  const path = join(dir, 'support.baseline.json');
  if (recorded !== undefined) await writeBaseline(path, recorded);
  return { path, dir };
}
