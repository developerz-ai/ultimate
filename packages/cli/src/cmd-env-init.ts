// `x env init --production`: the one writer of `.env.production`, the file `x deploy --method
// compose` reads and nothing else wrote. Values come from the app's own compose file and env
// declaration (`env-production.ts`); secrets are minted here, written once, and never printed.

// why: Bun.write takes neither an exclusive-create flag nor a file mode, and a secrets file needs
// both: `wx` refuses a file that appeared since the check, 0600 keeps it from other users.
import { writeFile } from 'node:fs/promises';
// why: Bun ships no path-join primitive, and both files are app-root-relative.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { generateVapidKeys } from '@ultimat3/pwa';
import { appSecretFacts, loadEnvSchema } from './app-env';
import { requireAppRoot } from './app-root';
import { readComposeFile } from './cmd-deploy-compose';
import type { CommandContext } from './command';
import { productionEnvFile } from './env-production';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool } from './parse';
import { PROD_ENV_FILE } from './templates/scaffold-container-compose';

/**
 * The file exists. Never overwritten: it holds the password the database volume was initialised
 * with and the keys every session and cursor is signed with, so new ones lock the running deploy
 * out of its own data.
 */
export class EnvFileExistsError extends UltimateError {
  constructor(input: { path: string }) {
    super({
      code: 'X_ENV_FILE_EXISTS',
      cause: `${input.path} already exists, and x env init would replace the secrets this deploy runs with`,
      // `NODE_ENV=production` is what makes Bun load `.env.production` into the check's process.
      fix: `NODE_ENV=production x env check --json   # the file is kept: edit a value in ${input.path} by hand`,
    });
  }
}

/** 32 random bytes as hex — `openssl rand -hex 32`, without needing openssl on the box. */
export const randomSecret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

/** `.gitignore` gains the file unless a line already names it; the scaffold's ignores `.env` only. */
async function ignoreEnvFile(root: string): Promise<boolean> {
  const path = join(root, '.gitignore');
  const file = Bun.file(path);
  const text = (await file.exists()) ? await file.text() : '';
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(PROD_ENV_FILE) || lines.includes(`/${PROD_ENV_FILE}`)) return false;
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  await Bun.write(path, `${text}${separator}${PROD_ENV_FILE}\n`);
  return true;
}

export async function initProductionEnv(
  ctx: CommandContext,
  secret: () => string = randomSecret,
): Promise<CommandResult> {
  if (!flagBool(ctx.args, 'production')) {
    throw new BadFlagError({
      flag: 'production',
      command: 'env init',
      reason: `init writes ${PROD_ENV_FILE}, the one environment a compose deploy reads`,
      fix: 'x env init --production --json',
    });
  }
  const root = requireAppRoot('env init', ctx.cwd).dir;
  const path = join(root, PROD_ENV_FILE);
  if (await Bun.file(path).exists()) throw new EnvFileExistsError({ path: PROD_ENV_FILE });
  const facts = await appSecretFacts(root);
  const env = productionEnvFile({
    schema: (await loadEnvSchema(root)) ?? {},
    compose: await readComposeFile(join(root, 'docker', 'docker-compose.prod.yml')),
    facts,
    secret,
    vapid: facts.push ? await generateVapidKeys() : undefined,
  });
  // Ignored before it is written: a crash between the two must not leave secrets to `git add -A`.
  const ignored = await ignoreEnvFile(root);
  await writeFile(path, env.contents, { flag: 'wx', mode: 0o600 });
  const complete = env.unfilled.length === 0;
  return {
    // Written either way — a rerun refuses the file — and red until every required key has a value.
    ok: complete,
    command: 'env',
    summary: msg('cli.env.initialised', { path: PROD_ENV_FILE, count: env.written.length }),
    lines: env.unfilled.map((key) => msg('cli.env.unfilled', { key, path: PROD_ENV_FILE })),
    findings: env.unfilled.map((key) => ({
      code: 'X_ENV_MISSING',
      cause: `${key} is required, and nothing in this app says what its production value is`,
      fix: `NODE_ENV=production x env check --json   # after setting ${key} in ${PROD_ENV_FILE}`,
      at: PROD_ENV_FILE,
    })),
    data: {
      path: PROD_ENV_FILE,
      written: [...env.written],
      unfilled: [...env.unfilled],
      gitignored: ignored,
    },
    exitCode: complete ? 0 : 1,
  };
}
