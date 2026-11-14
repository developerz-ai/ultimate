// `scripts/private-names-match.ts`: what one line carries, on invented names. The setup mode is
// built from parts here too, so this file never carries it whole either.

import { describe, expect, test } from 'bun:test';
import {
  denyListFromEnv,
  ENV_NAME,
  lineHit,
  nameMatch,
  REPOS_ENV,
  repositoryMatchers,
  tokenMatch,
} from './private-names-match';

const MODE = ['dz', 'runner'].join('-');
const REPOS = repositoryMatchers(['zorblax-co/vault', 'quimtel/ops.site']);

describe('private-names-match · the secret', () => {
  test('comma- or newline-separated, trimmed and lowercased; a `/` makes a repository', () => {
    expect(denyListFromEnv({ [ENV_NAME]: ' Quimtel ,zorblax.io\n\nZorblax-Co/Vault\n' })).toEqual({
      names: ['quimtel', 'zorblax.io'],
      repositories: ['zorblax-co/vault'],
    });
    expect(denyListFromEnv({})).toEqual({ names: [], repositories: [] });
  });

  test('both secrets are read: the names one first, each entry classified by its `/`', () => {
    const env = { [ENV_NAME]: 'quimtel\nzorblax-co/vault', [REPOS_ENV]: 'Quimtel/Ops.site\nstray' };
    expect(denyListFromEnv(env)).toEqual({
      names: ['quimtel', 'stray'],
      repositories: ['zorblax-co/vault', 'quimtel/ops.site'],
    });
    expect(denyListFromEnv({ [REPOS_ENV]: 'quimtel/ops.site' })).toEqual({
      names: [],
      repositories: ['quimtel/ops.site'],
    });
  });
});

describe('private-names-match · an adopter name', () => {
  test('a token matches exactly, or as a subdomain of a dotted entry', () => {
    expect(tokenMatch('quimtel', ['quimtel'])).toBe(1);
    expect(tokenMatch('a.zorblax.io', ['quimtel', 'zorblax.io'])).toBe(2);
    expect(tokenMatch('a.quimtel', ['quimtel'])).toBeUndefined();
    expect(nameMatch('see quimtel-tools and quimtels', ['quimtel'])).toBeUndefined();
  });
});

describe('private-names-match · a private repository', () => {
  test.each([
    'see zorblax-co/vault#1633',
    'https://github.com/Zorblax-Co/Vault.git',
    '`zorblax-co/vault`, and',
    'quimtel/ops.site.',
  ])('%s is refused', (line) => {
    expect(lineHit(line, [], REPOS)?.kind).toBe('repository');
  });

  test.each([
    'zorblax-co/vault-tools',
    'xzorblax-co/vault',
    'zorblax-co/vaults',
    'quimtel/ops.sites',
  ])('%s passes: a longer name is another repository', (line) => {
    expect(lineHit(line, [], REPOS)).toBeUndefined();
  });

  test('the entry index is 1-based among repositories', () => {
    expect(lineHit('quimtel/ops.site', [], REPOS)).toEqual({ kind: 'repository', index: 2 });
  });
});

describe('private-names-match · the setup mode', () => {
  test.each([
    MODE,
    MODE.toUpperCase(),
    MODE.replace('-', ' '),
    MODE.replace('-', ''),
    `a ${MODE} box`,
  ])('%s is refused with no secret at all', (line) => {
    expect(lineHit(line, [], [])).toEqual({ kind: 'setup-mode' });
  });

  test('inside a longer word it passes', () => {
    expect(lineHit(`x${MODE}s`, [], [])).toBeUndefined();
    expect(lineHit('runner and dz apart', [], [])).toBeUndefined();
  });

  test('the matcher source never carries the name whole', async () => {
    const source = await Bun.file(new URL('./private-names-match.ts', import.meta.url)).text();
    expect(source.toLowerCase()).not.toContain(MODE);
    expect(lineHit(source, [], [])).toBeUndefined();
  });
});
