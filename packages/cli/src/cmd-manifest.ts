// `x manifest` — regenerate x.manifest.json and openapi.json from the code. Facts are generated,
// conventions are hand-written: nothing in this file writes prose, and nothing else in the app is
// allowed to hand-edit these two files.

import { join } from 'node:path';
import type { Manifest } from '@ultimat3/manifest';
import { assertNoDrift, MANIFEST_FILENAME } from '@ultimat3/manifest';
import { writeAppArtifacts } from './app-artifacts';
import { appManifest } from './app-manifest';
import { openApiStaleness } from './app-openapi';
import { requireAppRoot } from './app-root';
import { manifestSpec } from './cmd-manifest-spec';
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
  spec: manifestSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('manifest', ctx.cwd).dir;
    const { manifest, findings } = await appManifest(root);
    const counts = countsOf(manifest);

    if (flagBool(ctx.args, 'check')) {
      // BOTH files the command writes: `--check` compared only `x.manifest.json`, so a stale
      // `openapi.json` — the one the typed client is generated from — read as fresh.
      const stale = [
        ...[await staleness(root, manifest)].filter((one) => one !== undefined),
        ...(await openApiStaleness(root, manifest)),
      ];
      return {
        ok: stale.length === 0 && findings.length === 0,
        command: 'manifest',
        summary: stale.length === 0 ? msg('cli.manifest.fresh') : msg('cli.manifest.stale'),
        findings: [...findings, ...stale],
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

    await writeAppArtifacts(root, manifest, {
      openapi: ctx.args.flags.get('openapi') !== false,
      onlyExisting: false,
    });
    const path = join(root, MANIFEST_FILENAME);
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
