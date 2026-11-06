// `x mail preview <id>` — a template checked in every locale without triggering the flow that
// sends it: `@ultimat3/mail`'s `previewMail` over the mail's declared `preview` data. A key a
// locale cannot resolve is named in `--json` and fails the command, as `send` would refuse it.

// why: Bun exposes no path-join primitive; `--out` is a directory the files are joined under.
import { join, resolve } from 'node:path';
import { appLocaleSet } from '@ultimat3/i18n/app-catalogs';
import { previewMail } from '@ultimat3/mail';
import { assertTimeZone } from '@ultimat3/time';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { mailSpec } from './cmd-mail-spec';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

/** A sample has no reader, so no reader's zone: UTC unless `--tz` names one — never the ambient. */
const PREVIEW_ZONE = 'UTC';

export const mailCommand: CliCommand = {
  spec: mailSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('mail', ctx.cwd).dir;
    const id = ctx.args.positionals[0];
    if (id === undefined) {
      throw new MissingPositionalError({
        command: 'mail preview',
        positional: 'id',
        example: 'x mail preview welcome --locale es',
      });
    }
    await loadApp(root);
    const asked = flagString(ctx.args, 'locale');
    const locales = asked === undefined ? (await appLocaleSet(root)).locales : [asked];
    const tz = assertTimeZone(flagString(ctx.args, 'tz') ?? PREVIEW_ZONE);
    const out = flagString(ctx.args, 'out');
    const previews: Record<string, JsonValue>[] = [];
    for (const locale of locales) {
      const preview = previewMail(id, { locale, tz });
      const files: string[] = [];
      if (out !== undefined) {
        const base = join(resolve(ctx.cwd, out), `${id}.${preview.locale}`);
        await Bun.write(`${base}.html`, preview.html);
        await Bun.write(`${base}.txt`, preview.text);
        files.push(`${base}.html`, `${base}.txt`);
      }
      previews.push({
        locale: preview.locale,
        subject: preview.subject,
        missing: preview.misses.map((miss) => miss.key),
        files,
      });
    }
    const missing = previews.filter(
      (each) => Array.isArray(each['missing']) && each['missing'].length > 0,
    );
    return {
      ok: missing.length === 0,
      command: 'mail',
      summary: msg(missing.length === 0 ? 'cli.mail.preview.ok' : 'cli.mail.preview.missing', {
        id,
        missing: missing.length,
        locales: previews.length,
      }),
      data: { id, previews, tz },
    };
  },
};
