// `x config show [--section <key>]` — the app's `AppConfig` as the boot reads it: `app.config.ts`
// through `loadAppConfig` (core's `defineConfig`, defaults merged), credentials redacted by
// `config-redact.ts`. The answer to "what is this app actually configured to do", without a boot.

import { ConfigInvalidError } from '@ultimat3/core';
import { loadAppConfig } from './app-config-load';
import { requireAppRoot } from './app-root';
import { configSpec } from './cmd-config-spec';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { redactConfigValue } from './config-redact';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

/** The record's own keys, sorted — the closed set `--section` is held to. */
const sectionsOf = (config: object): readonly string[] => Object.keys(config).sort();

export const configCommand: CliCommand = {
  spec: configSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('config', ctx.cwd);
    const config = await loadAppConfig(root.dir);
    // `requireAppRoot` found the file, so only a race with a delete lands here.
    if (config === undefined) {
      throw new ConfigInvalidError({
        cause: `${root.configPath} vanished between finding the app and reading it`,
        fix: "export const config = defineConfig({ name: 'my-app' });",
      });
    }
    const sections = sectionsOf(config);
    const section = flagString(ctx.args, 'section');
    // `Object.hasOwn`, never `config[section]` first: `--section constructor` would answer the
    // record's prototype method as if the app had declared it.
    if (section !== undefined && !Object.hasOwn(config, section)) {
      throw new BadFlagError({
        flag: 'section',
        command: 'config show',
        reason: `"${section}" is not a key of the resolved config (known: ${sections.join(', ')})`,
        fix: 'x config show --section cache --json',
      });
    }
    const whole = redactConfigValue(config) as { readonly [key: string]: JsonValue };
    const shown: JsonValue = section === undefined ? whole : (whole[section] ?? null);
    return ok(
      'config',
      section === undefined
        ? msg('cli.config.show', {
            name: config.name,
            count: sections.length,
            path: root.configPath,
          })
        : msg('cli.config.section', { section, path: root.configPath }),
      {
        lines: JSON.stringify(shown, null, 2).split('\n'),
        data: { path: root.configPath, section: section ?? null, config: shown },
      },
    );
  },
};
