// The chart `x new` writes against the framework's own (`docker/helm/`). The two differ in prose and
// in what the framework chart adds (a ServiceAccount, a ServiceMonitor), so bytes cannot be held
// equal — but the PROBES a role gets, the SPEC of its Service and the Secret it reads are behaviour,
// and so are a bounded /tmp and the NetworkPolicy — the framework chart gaining a replicator
// readiness probe or a per-role Secret while the scaffold kept neither is the drift this refuses.

import { expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { names } from './naming';
import { helmTemplateFiles } from './scaffold-helm-templates';

const CHART = join(import.meta.dir, '..', '..', '..', '..', 'docker', 'helm', 'templates');

const generated = (file: string): string =>
  String(
    helmTemplateFiles(names('ultimate')).find(
      (entry) => entry.path === `docker/helm/templates/${file}`,
    )?.contents ?? '',
  );

/** The lines that render: Go-template comments and `#` comments dropped, trailing space trimmed. */
const rendered = (text: string): readonly string[] =>
  text
    .replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

/** The lines from the first one matching `from` up to (not including) the first matching `to`. */
const between = (lines: readonly string[], from: RegExp, to: RegExp): readonly string[] => {
  const start = lines.findIndex((line) => from.test(line));
  const end = lines.findIndex((line, index) => index > start && to.test(line));
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end);
};

test('every role gets the probes the framework chart gives it', async () => {
  const chart = rendered(await Bun.file(join(CHART, '_helpers.tpl')).text());
  const scaffold = rendered(generated('_helpers.tpl'));
  const probes = (lines: readonly string[]) =>
    between(lines, /^ {2}startupProbe:/, /^ {2}resources:/);
  expect(probes(scaffold)).toEqual(probes(chart));
});

test('every role`s Service has the spec the framework chart gives it', async () => {
  const chart = rendered(await Bun.file(join(CHART, 'service.yaml')).text());
  const scaffold = rendered(generated('service.yaml'));
  const spec = (lines: readonly string[]) => between(lines, /^spec:/, /^ {2}ports:/);
  expect(spec(scaffold)).toEqual(spec(chart));
});

test('every role reads the Secret the framework chart gives it — its own, or the release-wide one', async () => {
  const chart = rendered(await Bun.file(join(CHART, '_helpers.tpl')).text());
  const scaffold = rendered(generated('_helpers.tpl'));
  const secret = (lines: readonly string[]) =>
    between(lines, /^ {2}envFrom:/, /\$cfg\.port \$scraped/);
  expect(secret(scaffold)).toEqual(secret(chart));
  expect(secret(chart).join('\n')).toContain('$cfg.existingSecret');
});

test('/tmp is bounded the way the framework chart bounds it, at both of its mounts', async () => {
  const chart = rendered(await Bun.file(join(CHART, '_helpers.tpl')).text());
  const scaffold = rendered(generated('_volumes.tpl'));
  const body = (lines: readonly string[]) => between(lines, /^- name: tmp$/, /^\{\{- end -\}\}$/);
  expect(body(scaffold)).toEqual(body(chart));
  expect(body(chart).join('\n')).toContain('sizeLimit');
  for (const file of ['deployments.yaml', 'migrate-job.yaml']) {
    expect({ [file]: generated(file).includes('emptyDir: {}') }).toEqual({ [file]: false });
    expect(generated(file)).toContain('.tmpVolume');
  }
});

test('every role`s NetworkPolicy has the spec the framework chart gives it', async () => {
  const chart = rendered(await Bun.file(join(CHART, 'networkpolicy.yaml')).text());
  const scaffold = rendered(generated('networkpolicy.yaml'));
  const spec = (lines: readonly string[]) => between(lines, /^spec:/, /^\{\{- end \}\}$/);
  expect(spec(scaffold)).toEqual(spec(chart));
  expect(spec(chart).join('\n')).toContain('port: metrics');
});
