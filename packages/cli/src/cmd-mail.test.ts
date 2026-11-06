// `x mail preview` end to end against the reference app: its declared preview, rendered in the
// locale asked, with `--json`'s shape pinned; and the two refusals a caller meets first.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; `--out` needs a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir primitive.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { resetDeclaredTags } from '@ultimat3/cache';
import { blocks, defineMail, t } from '@ultimat3/mail';
import { clearRoutes } from '@ultimat3/render';
import { clearStylesheets } from '@ultimat3/render/server';
import { resetAppLoad } from './app-load';
import { REQUIRED_BUN } from './app-root';
import { resetRegistries } from './cmd-dev-fixture';
import { mailCommand } from './cmd-mail';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import { parseArgs } from './parse';

const DUMMY = join(import.meta.dir, '..', '..', '..', 'examples', 'dummy');

// Loading the reference app fills every process-global registry; this file leaves none dirty.
afterAll(() => {
  clearRoutes();
  clearStylesheets();
  resetRegistries();
  resetAppLoad();
  resetDeclaredTags();
});

const runner = async (command: readonly string[]): Promise<ExecResult> => ({
  command,
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const context = (argv: readonly string[]): CommandContext =>
  ({
    args: parseArgs(['mail', ...argv], [mailCommand.spec]),
    cwd: DUMMY,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  }) as CommandContext;

describe('x mail preview', () => {
  test("renders the mail's declared preview in the locale asked, keys resolved", async () => {
    const result = await mailCommand.run(
      context(['preview', 'contact.sales-receipt', '--locale', 'es', '--json']),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      id: 'contact.sales-receipt',
      previews: [
        { locale: 'es', subject: 'Recibimos tu consulta de Postly', missing: [], files: [] },
      ],
      tz: 'UTC',
    });
  }, 60_000);

  test('every date renders in --tz, UTC when none is given — never the ambient zone', async () => {
    // Loaded first, so the probe below is registered beside the app's mails, not wiped by the load.
    await mailCommand.run(context(['preview', 'contact.sales-receipt', '--locale', 'en']));
    defineMail<Record<string, never>>({
      id: 'cli-test.tz-probe',
      subject: 'mail.signoff',
      input: t.object({}),
      template: ({ tz }) => [blocks.detail('mail.signoff', `zone=${tz}`)],
      preview: {},
    });
    const out = await mkdtemp(join(tmpdir(), 'x-test-mail-tz-'));
    const zoneOf = async (argv: readonly string[]): Promise<string | undefined> => {
      await mailCommand.run(
        context(['preview', 'cli-test.tz-probe', '--locale', 'en', '--out', out, ...argv]),
      );
      return /zone=([A-Za-z_/]+)/.exec(
        await Bun.file(join(out, 'cli-test.tz-probe.en.txt')).text(),
      )?.[1];
    };
    expect(await zoneOf([])).toBe('UTC');
    expect(await zoneOf(['--tz', 'Asia/Kolkata'])).toBe('Asia/Kolkata');
    await expect(
      mailCommand.run(context(['preview', 'cli-test.tz-probe', '--locale', 'en', '--tz', 'EST'])),
    ).rejects.toBeUltimateError('X_TIMEZONE_INVALID');
    await rm(out, { recursive: true, force: true });
  }, 60_000);

  test('no id is a missing positional; an unknown id is the mail registry’s own refusal', async () => {
    await expect(mailCommand.run(context(['preview']))).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
    await expect(
      mailCommand.run(context(['preview', 'no.such-mail', '--locale', 'en'])),
    ).rejects.toBeUltimateError('X_MAIL_TEMPLATE_UNKNOWN');
  }, 60_000);
});
