// `x secrets` — the committed encrypted file, end to end: seal it, edit it, add one value, rotate
// the master key, and report what is in it without ever printing what is in it. Every fact about
// the envelope comes from `@ultimat3/core`; this file owns the terminal, the temporary plaintext
// buffer, and the `.gitignore` rule that keeps the master key out of the repository.

// Bun ships no temp-directory primitive and no path join. `rmSync` is the synchronous half: a
// signal handler that awaited would be racing the default action it is trying to beat.
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MasterKeyRef, SecretValues } from '@ultimat3/core';
import {
  assertSecretValues,
  describeSecrets,
  generateMasterKey,
  masterKeyIdOf,
  masterKeyPath,
  REDACTED,
  readSecretsFile,
  requireMasterKey,
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
  SecretsPlaintextInvalidError,
  secretsFileExists,
  serializeSecretValues,
  writeMasterKeyFile,
  writeSecretsFile,
} from '@ultimat3/core';
import { ENV_SCHEMA_EXPORT, loadEnvSchema } from './app-env';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import {
  BadFlagError,
  SecretsEditFailedError,
  SecretsEditorMissingError,
  SecretsExistsError,
} from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { renderTable } from './table';

export const SECRETS_SUBCOMMANDS = ['show', 'init', 'edit', 'set', 'rotate'] as const;

/** In order of precedence. `VISUAL` outranks `EDITOR` by POSIX convention on an interactive tty. */
export const EDITOR_VARS = ['VISUAL', 'EDITOR'] as const;

const GITIGNORE = '.gitignore';

export type EditorLauncher = (command: readonly string[], cwd: string) => Promise<number>;

/** The two things this command needs from the terminal, injected so a test can supply both. */
export interface SecretsIo {
  readonly launch: EditorLauncher;
  readonly readValue: () => Promise<string>;
}

/**
 * Deliberately NOT through `exec.ts`. That boundary pipes stdout and ignores stdin by contract, and
 * an editor handed a pipe where it expected a terminal draws nothing and never returns. The seam
 * that keeps this testable is `SecretsIo` on the command, not a `Runner` on the context.
 */
const spawnEditor: EditorLauncher = (command, cwd) =>
  Bun.spawn([...command], { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited;

export const DEFAULT_SECRETS_IO: SecretsIo = {
  launch: spawnEditor,
  readValue: () => Bun.stdin.text(),
};

interface Session {
  readonly root: string;
  readonly key: MasterKeyRef;
}

const open = (ctx: CommandContext, subcommand: string): Session => {
  const root = requireAppRoot(`secrets ${subcommand}`, ctx.cwd).dir;
  return { root, key: requireMasterKey(root, ctx.env) };
};

const names = (values: SecretValues): readonly string[] => Object.keys(values).sort();

/** A buffer that will not parse is `X_SECRETS_PLAINTEXT_INVALID`, never a bare `SyntaxError`. */
function parseBuffer(text: string): SecretValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretsPlaintextInvalidError({ at: SECRETS_FILE, reason: 'are not JSON' });
  }
  return assertSecretValues(parsed, SECRETS_FILE);
}

/**
 * Make the ignore rule true before any key file exists. Ordering is the whole point: a key written
 * first is a key that is committable for however long it takes to get here, and one commit is
 * enough. A rule the repository already has is left alone rather than duplicated.
 */
async function ensureIgnored(root: string): Promise<'added' | 'present'> {
  const path = join(root, GITIGNORE);
  const file = Bun.file(path);
  const text = (await file.exists()) ? await file.text() : '';
  if (text.split('\n').some((line) => line.trim() === SECRETS_KEY_FILE)) return 'present';
  const head = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  const gap = head.length === 0 ? '' : '\n';
  await Bun.write(
    path,
    `${head}${gap}# The secrets master key. Never commit it — x secrets init writes this line first.\n${SECRETS_KEY_FILE}\n`,
  );
  return 'added';
}

async function init(ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot('secrets init', ctx.cwd).dir;
  if (secretsFileExists(root)) {
    throw new SecretsExistsError({ path: SECRETS_FILE, fix: 'x secrets edit' });
  }
  if (await Bun.file(masterKeyPath(root)).exists()) {
    throw new SecretsExistsError({ path: SECRETS_KEY_FILE, fix: 'x secrets rotate --json' });
  }
  const ignore = await ensureIgnored(root);
  const key: MasterKeyRef = {
    hex: generateMasterKey(),
    source: 'file',
    at: masterKeyPath(root),
  };
  writeMasterKeyFile(root, key.hex);
  await writeSecretsFile(root, {}, key);
  const keyId = await masterKeyIdOf(key);
  return {
    ok: true,
    command: 'secrets',
    summary: msg('cli.secrets.init', { path: SECRETS_FILE, kid: keyId }),
    // The key itself is never printed. This is the one line an operator needs to carry it into a
    // deploy, and it names the file rather than the value so a terminal transcript stays safe.
    lines: [msg('cli.secrets.deploy', { env: SECRETS_KEY_ENV, keyPath: SECRETS_KEY_FILE })],
    data: { path: SECRETS_FILE, keyPath: SECRETS_KEY_FILE, keyId, gitignore: ignore },
  };
}

/**
 * Decrypt into a temporary buffer, hand it to `$EDITOR`, reseal what comes back. The buffer lives
 * in the system temp directory and never inside the repository — a plaintext file under the app
 * root is one `git add -A` away from being the thing this whole feature prevents.
 *
 * A buffer that will not validate is refused AND discarded: the edit is lost, which is the smaller
 * of the two harms. Leaving decrypted values on disk so they can be recovered is the larger one.
 */
async function edit(ctx: CommandContext, io: SecretsIo): Promise<CommandResult> {
  const { root, key } = open(ctx, 'edit');
  const editor = EDITOR_VARS.map((name) => ctx.env[name]).find(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );
  if (editor === undefined) throw new SecretsEditorMissingError({ vars: EDITOR_VARS });
  const before = await readSecretsFile(root, key);
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-secrets-'));
  const buffer = join(dir, 'secrets.json');
  const shred = (): void => rmSync(dir, { recursive: true, force: true });
  // A `finally` does not run for a signal, and Ctrl-C inside an editor kills this process too.
  process.once('SIGINT', shred);
  process.once('SIGTERM', shred);
  try {
    await Bun.write(buffer, serializeSecretValues(before));
    // `$EDITOR` may carry flags (`code --wait`), and there is no shell here to split them.
    const code = await io.launch([...editor.trim().split(/\s+/), buffer], root);
    if (code !== 0) throw new SecretsEditFailedError({ editor, code });
    const after = parseBuffer(await Bun.file(buffer).text());
    // Compared as PLAINTEXT: the IV is fresh on every seal, so comparing ciphertexts would rewrite
    // the committed file on every edit session whether or not a value moved.
    if (serializeSecretValues(before) === serializeSecretValues(after)) {
      return {
        ok: true,
        command: 'secrets',
        summary: msg('cli.secrets.unchanged', { path: SECRETS_FILE }),
        data: { path: SECRETS_FILE, changed: false, added: [], updated: [], removed: [] },
      };
    }
    await writeSecretsFile(root, after, key);
    const added = names(after).filter((name) => before[name] === undefined);
    const removed = names(before).filter((name) => after[name] === undefined);
    const updated = names(after).filter(
      (name) => before[name] !== undefined && before[name] !== after[name],
    );
    return {
      ok: true,
      command: 'secrets',
      summary: msg('cli.secrets.edited', {
        path: SECRETS_FILE,
        added: added.length,
        updated: updated.length,
        removed: removed.length,
      }),
      data: { path: SECRETS_FILE, changed: true, added, updated, removed },
    };
  } finally {
    shred();
    process.off('SIGINT', shred);
    process.off('SIGTERM', shred);
  }
}

/**
 * The non-interactive write. The value comes from **stdin**, never from argv: an argument is in the
 * shell history of whoever ran it and in `ps` for everyone on the box for as long as the process
 * lives, and the primary user of this CLI is an agent that has no `$EDITOR` at all.
 *
 *     printf %s "$TOKEN" | x secrets set STRIPE_KEY --json
 */
async function set(ctx: CommandContext, io: SecretsIo): Promise<CommandResult> {
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    throw new BadFlagError({
      flag: 'name',
      command: 'secrets',
      reason: 'x secrets set <NAME> needs the environment variable name to seal the value under',
      fix: 'printf %s "$TOKEN" | x secrets set STRIPE_KEY --json',
    });
  }
  const { root, key } = open(ctx, 'set');
  const before = await readSecretsFile(root, key);
  // Exactly one trailing newline, because `echo` adds one and a secret with a stray `\n` fails
  // against the service it authenticates to with an error that names nothing.
  const value = (await io.readValue()).replace(/\r?\n$/, '');
  const after = assertSecretValues({ ...before, [name]: value }, SECRETS_FILE);
  await writeSecretsFile(root, after, key);
  return {
    ok: true,
    command: 'secrets',
    summary: msg('cli.secrets.set', {
      name,
      path: SECRETS_FILE,
      count: Object.keys(after).length,
    }),
    data: {
      path: SECRETS_FILE,
      name,
      added: before[name] === undefined,
      count: Object.keys(after).length,
    },
  };
}

/**
 * A new master key over the same values. The committed file is written FIRST and the key file last,
 * because only one of the two can be recovered: `secrets.enc.json` is in git, and a master key that
 * is half-overwritten is gone. Interrupted between the two writes, the old key still on disk meets
 * a file it cannot open — `X_SECRETS_KEY_MISMATCH`, whose fix restores the file from git.
 */
async function rotate(ctx: CommandContext): Promise<CommandResult> {
  const { root, key } = open(ctx, 'rotate');
  const values = await readSecretsFile(root, key);
  const previous = await masterKeyIdOf(key);
  const next: MasterKeyRef = {
    hex: generateMasterKey(),
    source: 'file',
    at: masterKeyPath(root),
  };
  await writeSecretsFile(root, values, next);
  await ensureIgnored(root);
  writeMasterKeyFile(root, next.hex);
  const keyId = await masterKeyIdOf(next);
  return {
    ok: true,
    command: 'secrets',
    summary: msg('cli.secrets.rotated', {
      path: SECRETS_FILE,
      from: previous,
      to: keyId,
      count: Object.keys(values).length,
    }),
    lines: [msg('cli.secrets.redeploy', { env: SECRETS_KEY_ENV, keyPath: SECRETS_KEY_FILE })],
    data: {
      path: SECRETS_FILE,
      keyPath: SECRETS_KEY_FILE,
      previousKeyId: previous,
      keyId,
      count: Object.keys(values).length,
    },
  };
}

/**
 * Names, lengths and whether `envSchema` declares each one. No value, in either renderer — the one
 * way to read a secret's value is the app reading `env.<NAME>`, and the one way to see it is
 * `x secrets edit`. A `--reveal` flag would be a second path that `--json` could not honour.
 */
async function show(ctx: CommandContext): Promise<CommandResult> {
  const { root, key } = open(ctx, 'show');
  const values = await readSecretsFile(root, key);
  const schema = await loadEnvSchema(root);
  const summaries = describeSecrets(values);
  const keyId = await masterKeyIdOf(key);
  const declared = (name: string): boolean | undefined =>
    schema === undefined ? undefined : schema[name] !== undefined;
  const undeclared = summaries
    .filter((entry) => declared(entry.name) === false)
    .map((entry) => entry.name);
  const rows = summaries.map((entry) => [
    entry.name,
    REDACTED,
    `${entry.length} chars`,
    declared(entry.name) === undefined ? '?' : declared(entry.name) === true ? 'yes' : 'no',
  ]);
  const lines = [
    ...(summaries.length === 0
      ? []
      : renderTable(['name', 'value', 'length', ENV_SCHEMA_EXPORT], rows)),
    ...(undeclared.length === 0
      ? []
      : [
          msg('cli.secrets.undeclared', { count: undeclared.length, names: undeclared.join(', ') }),
        ]),
  ];
  return {
    ok: true,
    command: 'secrets',
    summary:
      summaries.length === 0
        ? msg('cli.secrets.empty', { path: SECRETS_FILE })
        : msg('cli.secrets.shown', { count: summaries.length, path: SECRETS_FILE, kid: keyId }),
    lines,
    data: {
      path: SECRETS_FILE,
      keySource: key.source,
      keyId,
      count: summaries.length,
      secrets: summaries.map((entry) => ({
        name: entry.name,
        length: entry.length,
        declared: declared(entry.name) ?? null,
      })) as JsonValue,
      undeclared,
    },
  };
}

export function createSecretsCommand(io: SecretsIo): CliCommand {
  return {
    spec: {
      name: 'secrets',
      summary: `the committed encrypted secrets, decrypted into the ${ENV_SCHEMA_EXPORT} variables of the same names`,
      usage: 'x secrets [show|init|edit|set <NAME>|rotate] [--json]',
      requiresApp: true,
      subcommands: [...SECRETS_SUBCOMMANDS],
      // The bare `x secrets` answers without a key ever leaving the file. Declared, not inherited
      // from the array's order — `init`, `edit`, `set` and `rotate` all write.
      defaultSubcommand: 'show',
      flags: [],
    },
    async run(ctx: CommandContext): Promise<CommandResult> {
      switch (ctx.args.subcommand ?? 'show') {
        case 'init':
          return init(ctx);
        case 'edit':
          return edit(ctx, io);
        case 'set':
          return set(ctx, io);
        case 'rotate':
          return rotate(ctx);
        default:
          return show(ctx);
      }
    },
  };
}

export const secretsCommand: CliCommand = createSecretsCommand(DEFAULT_SECRETS_IO);
