// The secret-source suite over core's built-ins — the env var, the key file, the default that asks
// both — and an app-written KMS fake, and the proof it can fail: a source that keeps the first key
// it found for every root, and one that throws when it has none.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove API, so mkdtemp/rm come from node:fs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { SECRETS_KEY_ENV, SECRETS_KEY_FILE } from '@ultimat3/core';
import type { MasterKeyRef, SecretSource, SecretSourceContext } from '@ultimat3/core/adapter';
import { defaultSecretSource, envSecretSource, fileSecretSource } from '@ultimat3/core/adapter';
import type { SecretSourceSubject } from './secret-source-conformance';
import { SECRET_SOURCE_CHECKS, secretSourceConformance } from './secret-source-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const roots: string[] = [];
const freshRoot = async (): Promise<string> => {
  const root = await mkdtemp(`${tmpdir()}/ultimate-secret-source-`);
  roots.push(root);
  return root;
};

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const viaEnv = (source: SecretSource): SecretSourceSubject => ({
  source,
  holding: async (hex) => ({ root: await freshRoot(), env: { [SECRETS_KEY_ENV]: ` ${hex}\n` } }),
  empty: async () => ({ root: await freshRoot(), env: {} }),
});

const viaFile = (source: SecretSource): SecretSourceSubject => ({
  source,
  async holding(hex) {
    const root = await freshRoot();
    await writeFile(`${root}/${SECRETS_KEY_FILE}`, `${hex}\n`);
    return { root, env: {} };
  },
  empty: async () => ({ root: await freshRoot(), env: {} }),
});

/** An app's KMS source: an async lookup by root, its own table standing in for a vault. */
function kmsSubject(): SecretSourceSubject {
  const vault = new Map<string, string>();
  return {
    source: {
      name: 'kms',
      masterKey: async ({ root }) => {
        const hex = vault.get(root);
        return hex === undefined ? undefined : { hex, source: 'kms', at: `arn:aws:kms:${root}` };
      },
    },
    async holding(hex) {
      const root = await freshRoot();
      vault.set(root, hex);
      return { root, env: {} };
    },
    empty: async () => ({ root: await freshRoot(), env: {} }),
  };
}

describe(testName('unit', 'the env secret source'), () => {
  behavesLike(secretSourceConformance, () => viaEnv(envSecretSource));
});

describe(testName('unit', 'the file secret source'), () => {
  behavesLike(secretSourceConformance, () => viaFile(fileSecretSource));
});

describe(testName('unit', 'the default secret source, env leg'), () => {
  behavesLike(secretSourceConformance, () => viaEnv(defaultSecretSource));
});

describe(testName('unit', 'the default secret source, file leg'), () => {
  behavesLike(secretSourceConformance, () => viaFile(defaultSecretSource));
});

describe(testName('unit', 'an app-written KMS source'), () => {
  behavesLike(secretSourceConformance, kmsSubject);
});

/** Keeps the first key it was answered for every root after it — the cache that crossed apps. */
function remembering(): SecretSourceSubject {
  const inner = kmsSubject();
  let first: MasterKeyRef | undefined;
  return {
    ...inner,
    source: {
      name: 'remembering',
      masterKey: async (context: SecretSourceContext) => {
        first ??= await inner.source.masterKey(context);
        return first;
      },
    },
  };
}

/** Rejects for "absent": each caller refuses in its own words, not X_SECRETS_KEY_MISSING. */
function throwing(): SecretSourceSubject {
  const inner = kmsSubject();
  return {
    ...inner,
    source: {
      name: 'throwing',
      masterKey: async (context) => {
        const found = await inner.source.masterKey(context);
        return found ?? Promise.reject({ vault: 'no key for this root' });
      },
    },
  };
}

const check = (prefix: string) => {
  const found = SECRET_SOURCE_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no secret-source check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a source that breaks the contract fails conformance'), () => {
  test('a source that keeps one key for every root fails the two-places check', async () => {
    await check('a place holding a key').run(remembering());
    await expect(check('two places holding two keys').run(remembering())).rejects.toThrow();
  });

  test('a source that throws for absent fails the no-key check', async () => {
    await expect(check('a place holding no key').run(throwing())).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = SECRET_SOURCE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
