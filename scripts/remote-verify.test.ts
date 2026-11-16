// The remote gate's plan: ports shifted on the host side only and replaced (not appended) per
// service, URLs moved by the same offset, the gate's own words passed through untouched.

import { describe, expect, test } from 'bun:test';
import {
  highestPublishedPort,
  isSshHost,
  mirrorList,
  remoteScript,
  shellQuote,
  shiftedEnv,
  shiftedPortsOverride,
  splitArgs,
} from './remote-verify';

const COMPOSE = [
  'services:',
  '  postgres:',
  '    image: postgres:17',
  "    ports: ['127.0.0.1:5432:5432']",
  '  postgres-tls:',
  "    ports: ['127.0.0.1:5440:5432', '127.0.0.2:5440:5432']",
  '  certs:',
  '    image: alpine',
  '',
].join('\n');

describe('unit · remote-verify', () => {
  test('every published port moves on the host side, replaced with !override per service', () => {
    expect(shiftedPortsOverride(COMPOSE, 20_000)).toBe(
      [
        'services:',
        '  postgres:',
        "    ports: !override ['127.0.0.1:25432:5432']",
        '  postgres-tls:',
        "    ports: !override ['127.0.0.1:25440:5432', '127.0.0.2:25440:5432']",
        '',
      ].join('\n'),
    );
  });

  test('the services URLs move by the same offset; a path that is not a port is left alone', () => {
    const env = [
      'TEST_DATABASE_URL=postgres://u:p@127.0.0.1:5432/postgres',
      'TEST_REDIS_URL=redis://127.0.0.1:6379',
      'TEST_TLS_ROOT_CERT=docker/.tls/ca.crt',
    ].join('\n');
    expect(shiftedEnv(env, 20_000)).toBe(
      [
        'TEST_DATABASE_URL=postgres://u:p@127.0.0.1:25432/postgres',
        'TEST_REDIS_URL=redis://127.0.0.1:26379',
        'TEST_TLS_ROOT_CERT=docker/.tls/ca.crt',
      ].join('\n'),
    );
  });

  test("this script's flags are taken by name; every other word is the gate's, in order", () => {
    const split = splitArgs(['--host', 'box', '--only', 'unit', '--json', '--shard', '1/3', '--']);
    expect([...split.own]).toEqual([
      ['host', 'box'],
      ['json', 'true'],
    ]);
    expect(split.verifyArgs).toEqual(['--only', 'unit', '--shard', '1/3']);
  });

  test("the host's shell quotes every gate word and runs the shifted services before the gate", () => {
    const script = remoteScript({
      dir: ".cache/x/it's",
      offset: 20_000,
      verifyArgs: ['--only', 'a b'],
    });
    expect(script).toContain("cd '.cache/x/it'\\''s'");
    expect(script.indexOf('up -d --wait')).toBeGreaterThan(-1);
    expect(script.indexOf('up -d --wait')).toBeLessThan(script.indexOf('bun run verify'));
    expect(script.endsWith("bun run verify '--only' 'a b'")).toBe(true);
  });

  test('a host ssh or rsync would read as an option is refused (security review of 8a)', () => {
    for (const bad of ['-Fevil', '-ebash', '-oProxyCommand=x', '', 'a b', 'a;b']) {
      expect([bad, isSshHost(bad)]).toEqual([bad, false]);
    }
    for (const good of ['workspace', 'me@box.example', 'box-2']) expect(isSshHost(good)).toBe(true);
  });

  test('a directory name is one quoted word on the host: a checkout named with ; runs nothing', () => {
    expect(shellQuote('ultimate;touch pwned')).toBe("'ultimate;touch pwned'");
  });

  test('the mirror ships no .git/config or reflog, and nothing this tree deleted (review of #1161)', () => {
    const list = mirrorList({
      listed: ['a.ts', 'gone.ts', 'b.ts', ''],
      deleted: ['gone.ts'],
      git: ['.git/HEAD', '.git/config', '.git/logs/HEAD', '.git/objects/pack/p.pack'],
    });
    expect(list).toEqual([
      'a.ts',
      'b.ts',
      '.git/HEAD',
      '.git/objects/pack/p.pack',
      'docker/.remote-gate.override.yml',
      'docker/.remote-gate.env',
      'docker/.remote-gate.list',
    ]);
  });

  test('the host drops what the list does not name before it installs: the mirror is this tree', () => {
    const script = remoteScript({ dir: 'd', offset: 1, verifyArgs: [] });
    const prune = script.indexOf('grep -vxF -f docker/.remote-gate.list');
    expect(prune).toBeGreaterThan(-1);
    expect(prune).toBeLessThan(script.indexOf('bun install'));
  });

  test('the offset ceiling is 65535 minus the highest published port', () => {
    expect(highestPublishedPort(COMPOSE)).toBe(5440);
    expect(highestPublishedPort("    ports: ['127.0.0.1:16379:6379']")).toBe(16_379);
  });
});
