// `x manifest` — regenerate x.manifest.json and openapi.json from the code. Facts are generated,
// conventions are hand-written: nothing in this file writes prose, and nothing else in the app is
// allowed to hand-edit these two files.

import { join } from 'node:path';
import type { Manifest } from '@ultimat3/manifest';
import { assertNoDrift, MANIFEST_FILENAME } from '@ultimat3/manifest';
import { appManifest, writeAppManifest } from './app-manifest';
import { OPENAPI_FILE, openApiJson } from './app-openapi';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { findingFrom } from './output';
import { flagBool } from './parse';

const countsOf = (manifest: Manifest): JsonValue => ({
  routes: manifest.routes.length,
  actions: manifest.actions.length,
  mutators: manifest.actions.filter((action) => action.mutator === true).length,
  queries: manifest.queries.length,
  jobs: manifest.jobs.length,
  tasks: manifest.tasks.length,
  entities: manifest.entities.length,
  policies: manifest.policies.length,
});

/**
 * The identical comparison `x verify`'s `manifest` step makes, through the identical function.
 * A buildId equality test here would answer "fresh" for a hand-edited file whose body no longer
 * hashes to the id it carries — and two commands giving two answers about one file is itself the
 * drift the manifest exists to prevent.
 */
async function staleness(root: string, manifest: Manifest): Promise<Finding | undefined> {
  try {
    await assertNoDrift({ manifest, path: join(root, MANIFEST_FILENAME) });
    return undefined;
  } catch (error) {
    return { ...findingFrom(error), at: MANIFEST_FILENAME };
  }
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
    const { manifest, findings } = await appManifest(root);
    const counts = countsOf(manifest);

    if (flagBool(ctx.args, 'check')) {
      const stale = await staleness(root, manifest);
      return {
        ok: stale === undefined && findings.length === 0,
        command: 'manifest',
        summary: stale === undefined ? msg('cli.manifest.fresh') : msg('cli.manifest.stale'),
        findings: stale === undefined ? findings : [...findings, stale],
        data: { buildId: manifest.buildId, counts },
      };
    }

    // A module that would not load is omitted from the registries, so this projection describes a
    // subset of the app — and `x.manifest.json` is the compatibility contract. Write nothing.
    if (findings.length > 0) {
      return {
        ok: false,
        command: 'manifest',
        summary: msg('cli.manifest.blocked', { count: findings.length }),
        findings,
        data: { buildId: manifest.buildId, counts },
      };
    }

    const path = await writeAppManifest(root, manifest);
    if (ctx.args.flags.get('openapi') !== false) {
      await Bun.write(join(root, OPENAPI_FILE), openApiJson(manifest));
    }
    return {
      ok: true,
      command: 'manifest',
      summary: msg('cli.manifest.wrote', {
        path: MANIFEST_FILENAME,
        routes: manifest.routes.length,
        actions: manifest.actions.length,
      }),
      data: { path, buildId: manifest.buildId, counts },
    };
  },
};
