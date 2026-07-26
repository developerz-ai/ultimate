// `x manifest` — regenerate x.manifest.json and openapi.json from the code. Facts are generated,
// conventions are hand-written: nothing in this file writes prose, and nothing else in the app is
// allowed to hand-edit these two files.

import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import type { AppManifest } from './manifest-scan';
import { countOf, scanApp } from './manifest-scan';
import { msg } from './messages';
import { buildOpenApi } from './openapi';
import type { CommandResult, JsonValue } from './output';
import { flagBool } from './parse';

const stable = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function writeManifest(root: string, manifest: AppManifest): Promise<string> {
  const path = join(root, 'x.manifest.json');
  await Bun.write(path, stable(manifest));
  return path;
}

export const manifestCommand: CliCommand = {
  spec: {
    name: 'manifest',
    summary: 'regenerate x.manifest.json and openapi.json from the code',
    usage: 'x manifest [--check] [--json]',
    requiresApp: true,
    flags: [
      { name: 'check', type: 'boolean', summary: 'fail if the committed files are stale' },
      { name: 'openapi', type: 'boolean', summary: 'also write openapi.json', default: true },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('manifest', ctx.cwd).dir;
    const manifest = await scanApp({ root });
    const counts: JsonValue = {
      routes: countOf(manifest, 'route'),
      actions: countOf(manifest, 'action'),
      mutators: countOf(manifest, 'mutator'),
      queries: countOf(manifest, 'query'),
      jobs: countOf(manifest, 'job'),
      tasks: countOf(manifest, 'task'),
      entities: countOf(manifest, 'entity'),
      policies: countOf(manifest, 'policy'),
    };

    if (flagBool(ctx.args, 'check')) {
      const committed = await Bun.file(join(root, 'x.manifest.json'))
        .json()
        .catch(() => undefined);
      const fresh =
        committed !== null &&
        typeof committed === 'object' &&
        (committed as { buildId?: string }).buildId === manifest.buildId;
      return {
        ok: fresh,
        command: 'manifest',
        summary: fresh ? 'manifest is fresh' : 'manifest is stale',
        findings: fresh
          ? []
          : [
              {
                code: 'X_MANIFEST_STALE',
                cause: `x.manifest.json does not match build ${manifest.buildId}`,
                fix: 'x manifest',
                docs: 'https://ultimate.dev/errors/X_MANIFEST_STALE',
                at: 'x.manifest.json',
              },
            ],
        data: { buildId: manifest.buildId, counts },
      };
    }

    const path = await writeManifest(root, manifest);
    if (ctx.args.flags.get('openapi') !== false) {
      const version = (ctx.env['npm_package_version'] ?? '0.0.0') as string;
      await Bun.write(join(root, 'openapi.json'), stable(buildOpenApi(manifest, version)));
    }
    return {
      ok: true,
      command: 'manifest',
      summary: msg('cli.manifest.wrote', {
        path: 'x.manifest.json',
        routes: countOf(manifest, 'route'),
        actions: countOf(manifest, 'action'),
      }),
      data: { path, buildId: manifest.buildId, counts },
    };
  },
};
