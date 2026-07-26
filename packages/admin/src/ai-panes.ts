// Opt-in AI panes. Every pane is off until named in `enable`, and every pane declares the
// scope it needs — an anomaly pane that can read job metrics cannot also read rows, and the
// NL-query pane is bounded to the read-only DB tool. Nothing here runs without a runner.

import type { Gateway } from '@ultimat3/ai';
import { ADMIN_READ } from './permissions';
import type { AdminJobSummary } from './registry';

/** What a pane is allowed to look at. Checked by the caller against the actor's grants. */
export type AiPaneScope = 'jobs:read' | 'metrics:read' | 'db:read-only';

export interface AiPaneRequest {
  readonly system: string;
  readonly user: string;
  readonly scopes: readonly AiPaneScope[];
}

/**
 * The narrow slice of an AI gateway a pane uses. `Gateway` from @ultimat3/ai is adapted to
 * it by the host app, so a pane cannot reach a tool the app did not hand it.
 */
export interface AiRunner {
  complete(request: AiPaneRequest): Promise<string>;
}

export type GatewayAdapter = (gateway: Gateway) => AiRunner;

export interface AiPaneFacts {
  readonly jobs: readonly AdminJobSummary[];
  /** Queue depth per queue name, as the jobs panel already reports it. */
  readonly queueDepth: Readonly<Record<string, number>>;
  /** Failures per queue over the pane's window. */
  readonly failures: Readonly<Record<string, number>>;
  /** The operator's question, for the NL-query pane. Empty for the others. */
  readonly question: string;
}

export interface AiPane {
  readonly key: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly scopes: readonly AiPaneScope[];
  /** Admin permissions the viewer needs on top of the scope. */
  readonly permissions: readonly string[];
  readonly enabled: boolean;
  request(facts: AiPaneFacts): AiPaneRequest;
}

const facts = (input: AiPaneFacts): string =>
  JSON.stringify(
    {
      queueDepth: input.queueDepth,
      failures: input.failures,
      jobs: input.jobs.map((job) => ({ name: job.name, queue: job.queue ?? 'default' })),
    },
    null,
    2,
  );

const anomalyPane: AiPane = {
  key: 'anomaly',
  titleKey: 'admin.ai.anomaly.title',
  descriptionKey: 'admin.ai.anomaly.description',
  scopes: ['jobs:read', 'metrics:read'],
  permissions: [ADMIN_READ],
  enabled: false,
  request(input): AiPaneRequest {
    return {
      system:
        'You review background-job metrics. Report only deviations you can point at a number for. No advice.',
      user: `Queue and failure counts:\n${facts(input)}\n\nList anomalies as: queue, metric, observed, expected.`,
      scopes: ['jobs:read', 'metrics:read'],
    };
  },
};

const nlQueryPane: AiPane = {
  key: 'nl-query',
  titleKey: 'admin.ai.nl-query.title',
  descriptionKey: 'admin.ai.nl-query.description',
  // The DB tool this pane targets is the read-only one behind the /_x DB panel.
  scopes: ['db:read-only'],
  permissions: [ADMIN_READ],
  enabled: false,
  request(input): AiPaneRequest {
    return {
      system:
        'You write one read-only Postgres SELECT. No DML, no DDL, no CTE that writes. Return SQL only.',
      user: input.question,
      scopes: ['db:read-only'],
    };
  },
};

const forecastPane: AiPane = {
  key: 'backlog-forecast',
  titleKey: 'admin.ai.forecast.title',
  descriptionKey: 'admin.ai.forecast.description',
  scopes: ['jobs:read', 'metrics:read'],
  permissions: [ADMIN_READ],
  enabled: false,
  request(input): AiPaneRequest {
    return {
      system:
        'You forecast queue drain time from depth and throughput. State the assumption behind each number.',
      user: `Current state:\n${facts(input)}\n\nFor each queue: minutes to drain, and the throughput you assumed.`,
      scopes: ['jobs:read', 'metrics:read'],
    };
  },
};

export const AI_PANES: readonly AiPane[] = [anomalyPane, nlQueryPane, forecastPane];

export interface AiPanesOptions {
  /** Pane keys to switch on. Anything not listed stays off. */
  readonly enable?: readonly string[];
  readonly runner?: AiRunner;
}

/** The pane list for the admin shell: same shape whether AI is on or off. */
export function aiPanes(opts: AiPanesOptions = {}): readonly AiPane[] {
  const enable = new Set(opts.enable ?? []);
  return AI_PANES.map((pane) => ({ ...pane, enabled: enable.has(pane.key) }));
}

export type AiPaneResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/** A disabled pane, or a missing runner, is a refusal — never a silent no-op. */
export async function runAiPane(
  pane: AiPane,
  input: AiPaneFacts,
  runner: AiRunner | undefined,
): Promise<AiPaneResult> {
  if (!pane.enabled) return { ok: false, reason: 'admin.ai.disabled' };
  if (runner === undefined) return { ok: false, reason: 'admin.ai.no-runner' };
  return { ok: true, text: await runner.complete(pane.request(input)) };
}
