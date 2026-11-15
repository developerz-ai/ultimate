// docker/helm's liveness probe for the scrape-only roles (worker, scheduler, replicator) asks the
// one path on the metrics listener that reads the loops' heartbeats: `/healthz`
// (`livenessPayload()`, packages/cli/src/metrics-endpoint.ts). `/metrics` answers 200 for as long
// as the listener is up, so a wedged claim loop was never restarted.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { repoRoot } from './lib/run';

const HELPERS = join(repoRoot(), 'docker', 'helm', 'templates', '_helpers.tpl');

/** The scrape-only branch: from `else if $scraped` to the next `{{- end }}` at two-space depth. */
async function scrapedBranch(): Promise<string> {
  const text = await Bun.file(HELPERS).text();
  const start = text.indexOf('{{- else if $scraped }}');
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('\n  {{- end }}', start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('unit · docker/helm probes of the scrape-only roles', () => {
  test('liveness asks /healthz on the metrics port, the path that reads the heartbeats', async () => {
    const branch = await scrapedBranch();
    const liveness = /livenessProbe:\n\s+httpGet: \{ path: ([^,]+), port: (\w+) \}/.exec(branch);
    expect(liveness?.slice(1)).toEqual(['/healthz', 'metrics']);
  });
});
