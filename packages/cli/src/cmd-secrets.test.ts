// `x secrets` end to end against real files. The editor and stdin are injected, so the interesting
// paths — an editor that crashes, a buffer that will not validate, a rotation — are testable
// without a terminal. What every assertion here is really guarding is one rule: no plaintext value
// reaches the repository, the terminal or `--json`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway app roots.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateMasterKey,
  openSecrets,
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
} from '@ultimat3/core';
import { createSecretsCommand, type SecretsIo, secretsCommand } from './cmd-secrets';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import type { JsonValue } from './output';
import { parseArgs } from './parse';

const SCHEMA = `export const envSchema = {
  SESSION_SECRET: { type: 'string', secret: true, description: 'Cookie signing key' },
};
export const config = { name: 'fixture' };
`;

let base = '';
let counter = 0;

const runner = async (): Promise<ExecResult> => ({
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const context = (
  argv: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): CommandContext =>
  ({
    args: parseArgs([...argv], [secretsCommand.spec]),
    cwd,
    runner,
    env,
    bunVersion: '1.3.0',
  }) as CommandContext;

const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  (value ?? {}) as Record<string, JsonValue>;

/** An editor that replaces the buffer with `next`, and reports `code`. */
const editorWriting = (next: string, code = 0): SecretsIo => ({
  launch: async (command) => {
    const path = command[command.length - 1] ?? '';
    if (code === 0) await Bun.write(path, next);
    return code;
  },
  readValue: async () => '',
});

const stdin = (value: string): SecretsIo => ({
  launch: async () => 0,
  readValue: async () => value,
});

async function appRoot(name: string): Promise<string> {
  counter += 1;
  const dir = join(base, `${name}-${counter}`);
  await Bun.write(join(dir, 'app.config.ts'), SCHEMA);
  return dir;
}

/** A root that has been through `x secrets init`. */
async function initialized(name: string): Promise<string> {
  const root = await appRoot(name);
  await secretsCommand.run(context(['secrets', 'init'], root));
  return root;
}

const keyOf = async (root: string): Promise<string> =>
  (await Bun.file(join(root, SECRETS_KEY_FILE)).text()).trim();

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'x-cmd-secrets-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('unit · x secrets init', () => {
  test('it writes both files and a gitignore rule, and never prints the key', async () => {
    const root = await appRoot('init');
    const result = await secretsCommand.run(context(['secrets', 'init'], root));
    expect(result.ok).toBe(true);
    expect(record(result.data)['gitignore']).toBe('added');
    const key = await keyOf(root);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  // Safe by construction: the ignore rule has to be true before the key exists, or there is a
  // window in which `git add -A` commits it. Ordering is the only thing that closes it.
  test('the ignore rule names the key file', async () => {
    const root = await initialized('ignore');
    const ignore = await Bun.file(join(root, '.gitignore')).text();
    expect(ignore.split('\n')).toContain(SECRETS_KEY_FILE);
  });

  test('an existing rule is not duplicated', async () => {
    const root = await appRoot('ignore-present');
    await Bun.write(join(root, '.gitignore'), `node_modules/\n${SECRETS_KEY_FILE}\n`);
    const result = await secretsCommand.run(context(['secrets', 'init'], root));
    expect(record(result.data)['gitignore']).toBe('present');
    const ignore = await Bun.file(join(root, '.gitignore')).text();
    expect(ignore.split('\n').filter((line) => line === SECRETS_KEY_FILE)).toHaveLength(1);
  });

  test('the sealed file opens with the key it wrote', async () => {
    const root = await initialized('roundtrip');
    const text = await Bun.file(join(root, SECRETS_FILE)).text();
    expect(
      await openSecrets(text, await keyOf(root), { file: SECRETS_FILE, key: SECRETS_KEY_FILE }),
    ).toEqual({});
  });

  // Losing a master key is unrecoverable: the committed file it opens becomes ciphertext nobody
  // can read again, and `init` overwriting one silently is exactly how that happens.
  test('it refuses to overwrite an existing key file', async () => {
    const root = await initialized('conflict');
    await expect(secretsCommand.run(context(['secrets', 'init'], root))).rejects.toBeUltimateError(
      'X_GENERATE_CONFLICT',
    );
  });
});

describe('unit · x secrets set', () => {
  test('the value comes from stdin and is sealed, not stored in the clear', async () => {
    const root = await initialized('set');
    const command = createSecretsCommand(stdin('s3cr3t-value\n'));
    const result = await command.run(context(['secrets', 'set', 'SESSION_SECRET'], root));
    expect(result.ok).toBe(true);
    expect(record(result.data)['added']).toBe(true);
    const text = await Bun.file(join(root, SECRETS_FILE)).text();
    expect(text).not.toContain('s3cr3t-value');
    expect(
      await openSecrets(text, await keyOf(root), { file: SECRETS_FILE, key: SECRETS_KEY_FILE }),
    ).toEqual({ SESSION_SECRET: 's3cr3t-value' });
  });

  test('no value ever reaches --json', async () => {
    const root = await initialized('set-json');
    const command = createSecretsCommand(stdin('s3cr3t-value'));
    const result = await command.run(context(['secrets', 'set', 'SESSION_SECRET'], root));
    expect(JSON.stringify(result)).not.toContain('s3cr3t-value');
  });

  test('an empty value is refused rather than sealed as an unset variable', async () => {
    const root = await initialized('set-empty');
    const command = createSecretsCommand(stdin('\n'));
    await expect(
      command.run(context(['secrets', 'set', 'SESSION_SECRET'], root)),
    ).rejects.toBeUltimateError('X_SECRETS_PLAINTEXT_INVALID');
  });

  test('a name that is not an env var name is refused', async () => {
    const root = await initialized('set-name');
    const command = createSecretsCommand(stdin('value'));
    await expect(
      command.run(context(['secrets', 'set', 'sessionSecret'], root)),
    ).rejects.toBeUltimateError('X_SECRETS_PLAINTEXT_INVALID');
  });

  test('no name at all is a usage error naming the working invocation', async () => {
    const root = await initialized('set-noname');
    const command = createSecretsCommand(stdin('value'));
    await expect(command.run(context(['secrets', 'set'], root))).rejects.toBeUltimateError(
      'X_CLI_BAD_FLAG',
    );
  });
});

describe('unit · x secrets edit', () => {
  test('the buffer the editor is handed is plaintext, and the file it produces is not', async () => {
    const root = await initialized('edit');
    let handed = '';
    const io: SecretsIo = {
      launch: async (command) => {
        const path = command[command.length - 1] ?? '';
        handed = await Bun.file(path).text();
        await Bun.write(path, JSON.stringify({ SESSION_SECRET: 'from-editor' }));
        return 0;
      },
      readValue: async () => '',
    };
    const result = await createSecretsCommand(io).run(
      context(['secrets', 'edit'], root, { EDITOR: 'fake' }),
    );
    expect(handed).toBe('{}\n');
    expect(record(result.data)['added']).toEqual(['SESSION_SECRET']);
    expect(await Bun.file(join(root, SECRETS_FILE)).text()).not.toContain('from-editor');
  });

  test('the temporary buffer is deleted once the editor exits', async () => {
    const root = await initialized('edit-shred');
    let buffer = '';
    const io: SecretsIo = {
      launch: async (command) => {
        buffer = command[command.length - 1] ?? '';
        await Bun.write(buffer, JSON.stringify({ SESSION_SECRET: 'transient' }));
        return 0;
      },
      readValue: async () => '',
    };
    await createSecretsCommand(io).run(context(['secrets', 'edit'], root, { EDITOR: 'fake' }));
    expect(await Bun.file(buffer).exists()).toBe(false);
  });

  // The buffer must not survive a crash either — that is what the `finally` is for, and a test
  // that only covered the happy path would never have run it.
  test('an editor that exits non-zero leaves the file alone and deletes the buffer', async () => {
    const root = await initialized('edit-crash');
    let buffer = '';
    const io: SecretsIo = {
      launch: async (command) => {
        buffer = command[command.length - 1] ?? '';
        return 1;
      },
      readValue: async () => '',
    };
    const before = await Bun.file(join(root, SECRETS_FILE)).text();
    await expect(
      createSecretsCommand(io).run(context(['secrets', 'edit'], root, { EDITOR: 'fake' })),
    ).rejects.toBeUltimateError('X_SECRETS_EDIT_FAILED');
    expect(await Bun.file(buffer).exists()).toBe(false);
    expect(await Bun.file(join(root, SECRETS_FILE)).text()).toBe(before);
  });

  test('a buffer that is not JSON is refused, and the buffer is still deleted', async () => {
    const root = await initialized('edit-garbage');
    let buffer = '';
    const io: SecretsIo = {
      launch: async (command) => {
        buffer = command[command.length - 1] ?? '';
        await Bun.write(buffer, 'SESSION_SECRET=oops');
        return 0;
      },
      readValue: async () => '',
    };
    await expect(
      createSecretsCommand(io).run(context(['secrets', 'edit'], root, { EDITOR: 'fake' })),
    ).rejects.toBeUltimateError('X_SECRETS_PLAINTEXT_INVALID');
    expect(await Bun.file(buffer).exists()).toBe(false);
  });

  // The IV is fresh on every seal, so a byte comparison of the file would rewrite it every time.
  test('an unchanged buffer writes nothing, so a no-op edit produces no diff', async () => {
    const root = await initialized('edit-noop');
    const before = await Bun.file(join(root, SECRETS_FILE)).text();
    const result = await createSecretsCommand(editorWriting('{}\n')).run(
      context(['secrets', 'edit'], root, { EDITOR: 'fake' }),
    );
    expect(record(result.data)['changed']).toBe(false);
    expect(await Bun.file(join(root, SECRETS_FILE)).text()).toBe(before);
  });

  test('no $EDITOR is refused rather than guessed at', async () => {
    const root = await initialized('edit-noeditor');
    await expect(
      createSecretsCommand(editorWriting('{}')).run(context(['secrets', 'edit'], root)),
    ).rejects.toBeUltimateError('X_SECRETS_EDITOR_MISSING');
  });

  test('$VISUAL wins over $EDITOR, and flags on it survive the split', async () => {
    const root = await initialized('edit-visual');
    let launched: readonly string[] = [];
    const io: SecretsIo = {
      launch: async (command) => {
        launched = command;
        return 0;
      },
      readValue: async () => '',
    };
    await createSecretsCommand(io).run(
      context(['secrets', 'edit'], root, { EDITOR: 'vim', VISUAL: 'code --wait' }),
    );
    expect(launched.slice(0, 2)).toEqual(['code', '--wait']);
  });
});

describe('unit · x secrets show', () => {
  test('it prints names, lengths and the declaration, never a value', async () => {
    const root = await initialized('show');
    await createSecretsCommand(stdin('s3cr3t-value')).run(
      context(['secrets', 'set', 'SESSION_SECRET'], root),
    );
    const result = await secretsCommand.run(context(['secrets', 'show'], root));
    expect(result.ok).toBe(true);
    const rendered = [result.summary, ...(result.lines ?? []), JSON.stringify(result.data)].join(
      '\n',
    );
    expect(rendered).not.toContain('s3cr3t-value');
    expect(rendered).toContain('[redacted]');
    expect(record(result.data)['count']).toBe(1);
  });

  test('a secret the envSchema does not declare is called out — nothing reads it', async () => {
    const root = await initialized('show-undeclared');
    await createSecretsCommand(stdin('value')).run(context(['secrets', 'set', 'STRAY_KEY'], root));
    const result = await secretsCommand.run(context(['secrets', 'show'], root));
    expect(record(result.data)['undeclared']).toEqual(['STRAY_KEY']);
  });

  test('the env var beats the key file, so a deploy key is what opens the file', async () => {
    const root = await initialized('show-envkey');
    const result = await secretsCommand.run(
      context(['secrets', 'show'], root, { [SECRETS_KEY_ENV]: await keyOf(root) }),
    );
    expect(record(result.data)['keySource']).toBe('env');
  });

  test('a wrong key in the environment is X_SECRETS_KEY_MISMATCH, not an empty listing', async () => {
    const root = await initialized('show-wrongkey');
    await expect(
      secretsCommand.run(
        context(['secrets', 'show'], root, { [SECRETS_KEY_ENV]: generateMasterKey() }),
      ),
    ).rejects.toBeUltimateError('X_SECRETS_KEY_MISMATCH');
  });

  test('an app with no secrets file at all says so with a code, not an empty table', async () => {
    const root = await appRoot('show-nofile');
    await expect(
      secretsCommand.run(
        context(['secrets', 'show'], root, { [SECRETS_KEY_ENV]: generateMasterKey() }),
      ),
    ).rejects.toBeUltimateError('X_SECRETS_FILE_MISSING');
  });

  test('no key anywhere is X_SECRETS_KEY_MISSING', async () => {
    const root = await appRoot('show-nokey');
    await Bun.write(join(root, SECRETS_FILE), '{}');
    await expect(secretsCommand.run(context(['secrets', 'show'], root))).rejects.toBeUltimateError(
      'X_SECRETS_KEY_MISSING',
    );
  });
});

describe('unit · x secrets rotate', () => {
  test('the same values come back under a new key, and the old key no longer opens the file', async () => {
    const root = await initialized('rotate');
    await createSecretsCommand(stdin('s3cr3t-value')).run(
      context(['secrets', 'set', 'SESSION_SECRET'], root),
    );
    const previous = await keyOf(root);
    const result = await secretsCommand.run(context(['secrets', 'rotate'], root));
    expect(result.ok).toBe(true);
    const next = await keyOf(root);
    expect(next).not.toBe(previous);
    expect(record(result.data)['previousKeyId']).not.toBe(record(result.data)['keyId']);

    const text = await Bun.file(join(root, SECRETS_FILE)).text();
    const at = { file: SECRETS_FILE, key: SECRETS_KEY_FILE };
    expect(await openSecrets(text, next, at)).toEqual({ SESSION_SECRET: 's3cr3t-value' });
    await expect(openSecrets(text, previous, at)).rejects.toBeUltimateError(
      'X_SECRETS_KEY_MISMATCH',
    );
  });

  test('neither the old nor the new key is printed', async () => {
    const root = await initialized('rotate-quiet');
    const previous = await keyOf(root);
    const result = await secretsCommand.run(context(['secrets', 'rotate'], root));
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(previous);
    expect(rendered).not.toContain(await keyOf(root));
  });
});

describe('unit · the command spec', () => {
  test('the bare command is show — the read-only one, and the one that needs no editor', () => {
    expect(secretsCommand.spec.subcommands?.[0]).toBe('show');
  });

  test('it needs an app root: secrets belong to an app, never to a directory', () => {
    expect(secretsCommand.spec.requiresApp).toBe(true);
  });
});
