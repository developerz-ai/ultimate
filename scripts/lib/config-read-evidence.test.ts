// What counts as a READ of a config leaf: a qualified one, never a bare property name. Four dead
// keys (`jobs.maxAttempts`, `jobs.backoff`, `database.ssl`, `roles`) passed the ratchet because
// `retry.maxAttempts`, `pg.ssl` and a boot input's own `roles` field spelled the same word.

import { describe, expect, test } from 'bun:test';
import { checkConfigReaders } from '../config-readers';
import { configLeafTypes } from './config-leaves';
import { qualifiedRead } from './config-read-evidence';

const unread = (leaf: string, text: string, types: Readonly<Record<string, string>> = {}) =>
  checkConfigReaders({
    leaves: [leaf],
    files: [{ path: 'packages/jobs/src/a.ts', text }],
    pins: {},
    leafTypes: types,
  })
    .filter((gap) => gap.kind === 'unread')
    .map((gap) => gap.leaf);

describe('unit · a bare name on some other object is not a read', () => {
  test('jobs.maxAttempts beside a retry policy of the same field name is unread', () => {
    expect(unread('jobs.maxAttempts', 'const n = policy.maxAttempts;')).toEqual([
      'jobs.maxAttempts',
    ]);
  });

  test('database.ssl beside a driver option named ssl is unread', () => {
    expect(unread('database.ssl', 'const tls = { ssl: options.ssl };')).toEqual(['database.ssl']);
  });

  test('a top-level roles field on a boot input is not config.roles', () => {
    const text = 'import type { AppConfig } from "x";\nconst r = input.roles;';
    expect(unread('roles', text, { roles: 'AppConfig' })).toEqual(['roles']);
  });
});

describe('unit · the qualified reads that are', () => {
  test('<section>.<key>, optional-chained, and the bracketed key', () => {
    expect(qualifiedRead('jobs.maxAttempts', 'config.jobs.maxAttempts')).toBe(true);
    expect(qualifiedRead('jobs.maxAttempts', 'config?.jobs?.maxAttempts')).toBe(true);
    expect(qualifiedRead('pwa.categories', "strings(pwa['categories'])")).toBe(true);
  });

  test('a file that names the section type and reads the key', () => {
    const text = 'export function f(config: ClientErrorsConfig) { return config.anonymous; }';
    expect(qualifiedRead('clientErrors.anonymous', text, 'ClientErrorsConfig')).toBe(true);
    expect(qualifiedRead('clientErrors.anonymous', text, 'JobsConfig')).toBe(false);
  });

  test('a section aliased off a config, then its key read', () => {
    const text = 'const block = config?.failureCapture ?? D;\nconst n = block.perHour;';
    expect(qualifiedRead('failureCapture.perHour', text)).toBe(true);
    expect(qualifiedRead('failureCapture.perHour', 'const n = block.perHour;')).toBe(false);
  });

  test('a top-level leaf is read off a config only, never off the root type named nearby', () => {
    expect(qualifiedRead('roles', 'const r = appConfig.roles;', 'AppConfig')).toBe(true);
    expect(qualifiedRead('roles', 'const r = config?.roles;', 'AppConfig')).toBe(true);
    expect(qualifiedRead('roles', 'AppConfig; const r = input.roles;', 'AppConfig')).toBe(false);
  });
});

describe('unit · the leaf walk names each leaf declaring type', () => {
  test('a nested leaf maps to its section interface, a top-level one to the root', () => {
    const source = [
      'export interface AppConfig {',
      '  readonly name: string;',
      '  readonly jobs: JobsConfig;',
      '}',
      'export interface JobsConfig {',
      '  readonly maxAttempts: number;',
      '}',
    ].join('\n');
    expect(configLeafTypes(source)).toEqual({
      name: 'AppConfig',
      'jobs.maxAttempts': 'JobsConfig',
    });
  });
});
