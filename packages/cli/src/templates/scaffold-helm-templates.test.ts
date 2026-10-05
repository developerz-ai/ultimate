// Two rendering rules both charts hold — the framework's (`docker/helm/`) and the one `x new`
// writes: the replicator Deployment is Recreate, and the image reference is built from strings.
// No helm binary is assumed here, so the assertions read the templates; the rendered proof is the
// `container` job's `helm template` in `.github/workflows/ci.yml`.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { names } from './naming';
import { helmTemplateFiles } from './scaffold-helm-templates';

const HELM = join(import.meta.dir, '..', '..', '..', '..', 'docker', 'helm');

const generated = (file: string): string => {
  const found = helmTemplateFiles(names('ultimate')).find(
    (entry) => entry.path === `docker/helm/templates/${file}`,
  );
  if (found === undefined) return expect.unreachable(`no generated ${file}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${file} is bytes, not text`);
};

const framework = (file: string): Promise<string> => Bun.file(join(HELM, file)).text();

/** Both charts' copy of one template, labelled so a failure names the chart that drifted. */
const both = async (file: string): Promise<readonly [string, string][]> => [
  ['docker/helm', await framework(`templates/${file}`)],
  ['x new', generated(file)],
];

/** The `strategy:` block of a Deployment template, up to `template:`. */
const strategyOf = (text: string): string => {
  const start = text.indexOf('  strategy:');
  const end = text.indexOf('  template:', start);
  if (start < 0 || end < 0) return expect.unreachable('no strategy block');
  return text.slice(start, end);
};

/** The body of the `<chart>.image` helper. */
const imageHelperOf = (text: string): string => {
  const match = /\{\{- define "[\w-]+\.image" -\}\}\n([\s\S]*?)\{\{- end -\}\}/.exec(text);
  return match?.[1] ?? expect.unreachable('no image helper');
};

describe('unit · the replicator Deployment', () => {
  /**
   * One replicator per database holds the slot's advisory lock. Under `maxSurge: 1,
   * maxUnavailable: 0` the surged pod can only stand by unready, so the holder it waits on is never
   * terminated and every rollout stalls until its deadline. Recreate lets the holder go first.
   */
  test('is Recreate in both charts, and every other role keeps the rolling update', async () => {
    for (const [chart, text] of await both('deployments.yaml')) {
      const strategy = strategyOf(text);
      expect({
        chart,
        recreate: /\{\{- if eq \$role "replicator" \}\}\n\s+type: Recreate/.test(strategy),
      }).toEqual({
        chart,
        recreate: true,
      });
      expect({
        chart,
        rolling:
          /\{\{- else \}\}\n\s+type: RollingUpdate\n\s+rollingUpdate: \{ maxUnavailable: 0, maxSurge: 1 \}/.test(
            strategy,
          ),
      }).toEqual({
        chart,
        rolling: true,
      });
    }
  });
});

describe('unit · the image reference', () => {
  /**
   * `--set image.tag=1234567` is an int64 to helm, and `printf "%s:%s"` rendered
   * `app:%!s(int64=1234567)` into every Deployment and the migrate Job. `x deploy` now passes
   * `--set-string`; the helper holds for any other caller of the chart.
   */
  test('both halves go through toString in both charts', async () => {
    for (const [chart, text] of await both('_helpers.tpl')) {
      const helper = imageHelperOf(text);
      expect({
        chart,
        tag: helper.includes('(toString (default .Chart.AppVersion .Values.image.tag))'),
      }).toEqual({ chart, tag: true });
      expect({ chart, repository: helper.includes('(toString $repository)') }).toEqual({
        chart,
        repository: true,
      });
    }
  });

  test('an empty repository is a render error naming the key, in both charts', async () => {
    for (const [chart, text] of await both('_helpers.tpl')) {
      const helper = imageHelperOf(text);
      expect({
        chart,
        required:
          /\$repository := required "image\.repository is empty[^"]*--set-string image\.repository=/.test(
            helper,
          ),
      }).toEqual({ chart, required: true });
    }
  });

  /**
   * Rendered unquoted, a newline in `image.repository` was a YAML key of its own on the container
   * — `--set-string image.repository=$'app\nprivileged: true'` added a field to every pod spec.
   * Quoted, it is one string value however it is spelled, like ROLE and PORT beside it.
   */
  test('the container image is rendered quoted in both charts', async () => {
    for (const [chart, text] of await both('_helpers.tpl')) {
      const lines = text.split('\n').filter((line) => /^\s+image: /.test(line));
      expect({ chart, lines: lines.length }).toEqual({ chart, lines: 1 });
      expect({ chart, quoted: /\.image" \$root \| quote \}\}$/.test(lines[0] ?? '') }).toEqual({
        chart,
        quoted: true,
      });
    }
  });

  /**
   * The framework chart's default named `ghcr.io/developerz-ai/ultimate-app`, which no workflow
   * publishes — a fresh install pulled `manifest unknown`. A placeholder on a reserved domain says
   * what it is in the pull error, and the comment above it says what to set.
   */
  test('the framework chart ships a placeholder repository, not one nobody publishes', async () => {
    const values = Bun.YAML.parse(await framework('values.yaml')) as {
      image?: { repository?: unknown };
    };
    const repository = String(values.image?.repository ?? '');
    expect(repository).toMatch(/^registry\.example\.com\//);
    expect(repository).not.toContain('developerz-ai');
  });
});
