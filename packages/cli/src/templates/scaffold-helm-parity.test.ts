// The chart `x new` writes against the framework's own (`docker/helm/`). The two differ in prose and
// in what the framework chart adds (a ServiceAccount, a ServiceMonitor), so bytes cannot be held
// equal — but the PROBES a role gets and the SPEC of its Service are behaviour, and the framework
// chart gaining a replicator readiness probe and `publishNotReadyAddresses` while the scaffold kept
// neither is exactly the drift this file refuses.

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
