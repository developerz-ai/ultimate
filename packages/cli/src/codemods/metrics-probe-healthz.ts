// 31.25.0: a role with no HTTP socket is probed on `/healthz` of its scrape listener — the one path
// that reads the loops' heartbeats — where it was `/metrics`, which answers while a loop is stuck.
// The compose anchor and the chart's liveness probe, each where it stands as `x new` wrote it.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

const COMPOSE = 'docker/docker-compose.prod.yml';
const HELPERS = 'docker/helm/templates/_helpers.tpl';

const probe = (path: string): string =>
  `  test: ['CMD', 'bun', '--eval', "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9090)+'${path}').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`;

export const METRICS_PROBE_EDITS: Readonly<Record<string, readonly SnippetEdit[]>> = {
  [COMPOSE]: [
    {
      from: [
        '# gated on it never starts. Probes follow the role here, exactly as they do in `docker/helm`.',
        'x-metrics-probe: &metrics-probe',
        probe('/metrics'),
      ].join('\n'),
      to: [
        '# gated on it never starts. Probes follow the role here, exactly as they do in `docker/helm`:',
        "# `/healthz`, the one path on the scrape listener that reads the loops' heartbeats.",
        'x-metrics-probe: &metrics-probe',
        probe('/healthz'),
      ].join('\n'),
    },
  ],
  [HELPERS]: [
    {
      from: '  livenessProbe:\n    httpGet: { path: /metrics, port: metrics }\n    periodSeconds: 15',
      to: '  livenessProbe:\n    httpGet: { path: /healthz, port: metrics }\n    periodSeconds: 15',
    },
  ],
};

export const codemod: Codemod = {
  id: 'metrics-probe-healthz',
  since: '31.25.0',
  summary: `${COMPOSE} and ${HELPERS} probe a socketless role on /healthz, which reads its loops' heartbeats`,
  async run(app) {
    const results = [];
    for (const [path, edits] of Object.entries(METRICS_PROBE_EDITS)) {
      results.push(await editSnippets(app, path, edits));
    }
    return mergeResults(results);
  },
};
