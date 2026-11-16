// `x g sign-in --password` over a `runtime.ts` the author already edited — an app import and a
// spread of its own ports — held to the app's own first run: the spliced file compiles under the
// real `tsc`, passes the app's Biome, and the runtime tests load it.
// slow: one shape, end to end — x new, x g, Biome, the generated tests and tsc on the scaffold.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive.
import { mkdtemp } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { dispatch } from './dispatch';
import { firstRun, type Generated, removeGenerated } from './generate-contract-fixture';
import type { GeneratedFile } from './templates';
import { RUNTIME_MODULE } from './templates/scaffold-runtime-ports';

const EXTRA_PORTS = `// The app's own ports, spread into the runtime: what an adopter's runtime.ts looks like.
import type { RuntimeOverrides } from '@ultimat3/cli/serve';

type Env = Readonly<Record<string, string | undefined>>;

export const extraPorts = (env: Env): RuntimeOverrides =>
  (env['EXTRA_PORTS'] ?? '') === '' ? {} : {};
`;

describe('contract · x g sign-in splices into an edited runtime.ts', () => {
  test('--password over an extra import and spread: compiles, lints, its tests pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-sign-in-runtime-contract-'));
    await writeNewApp(root, { name: 'probe', example: true });
    const runtime = Bun.file(join(root, RUNTIME_MODULE));
    await Bun.write(
      runtime,
      (await runtime.text())
        .replace(
          "from '@ultimat3/cli/serve';\n",
          "from '@ultimat3/cli/serve';\nimport { extraPorts } from './extra-ports';\n",
        )
        .replace(
          'export const runtime = {\n',
          'export const runtime = {\n  ...extraPorts(Bun.env),\n',
        ),
    );
    await Bun.write(join(root, 'apps/web/extra-ports.ts'), EXTRA_PORTS);
    const out: string[] = [];
    const code = await dispatch({
      argv: ['g', 'sign-in', '--password', '--json'],
      cwd: root,
      env: {},
      bunVersion: Bun.version,
      write: (line) => out.push(line),
    });
    const files: GeneratedFile[] = [];
    for await (const path of new Bun.Glob('**/*').scan({ cwd: root, dot: true })) {
      files.push({ path, contents: await Bun.file(join(root, path)).bytes() });
    }
    const app: Generated = { root, code, out: out.join('\n'), files };
    try {
      expect({ code: app.code, out: app.out }).toMatchObject({ code: 0 });
      const spliced = await runtime.text();
      expect(spliced).toContain('assertSignInConfigured(process.env);');
      expect(spliced).toContain('...extraPorts(Bun.env),');
      const run = await firstRun(app, ['apps/web/app/auth', 'apps/web/runtime']);
      expect(run.diagnostics).toBe('');
      expect(run.lint).not.toContain('×');
      expect(run.tests.output).toMatch(/\b0 fail\b/);
      expect(run.tests.code).toBe(0);
    } finally {
      await removeGenerated(app);
    }
  }, 180_000);
});
