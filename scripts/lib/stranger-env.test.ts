// The environment a published package and a scaffolded app run in: an allowlist, never this
// process's environment plus an overlay — a maintainer's `.env` (`NPM_TOKEN`) must not reach them.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory or mkdir API; `node:fs` owns the throwaway directories.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only `node:os` answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { exec } from '@ultimat3/cli';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import {
  asOverlay,
  disposeStrangerHome,
  STRANGER_KEYS,
  strangerChild,
  strangerEnv,
  strangerEnvAt,
  strangerOverlayAt,
} from './stranger-env';

// It spawns the repo's own CLI and reads the tree, so it takes the repo-scan budget, not Bun's 5 s.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const parent = {
  PATH: '/usr/bin',
  Path: '/win/bin',
  LANG: 'C.UTF-8',
  HOME: '/home/maintainer',
  NPM_TOKEN: 'x',
  NPM_PASSWORD: 'x',
  GITHUB_TOKEN: 'x',
  AWS_SECRET_ACCESS_KEY: 'x',
  TEST_DATABASE_URL: 'postgres://localhost/test',
  UNSET: undefined,
};

describe('unit · stranger env', () => {
  test('only allowlisted and service keys pass; a secret never does', () => {
    const env = strangerEnv(parent, ['TEST_DATABASE_URL'], { HOME: '/clean/home' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      Path: '/win/bin',
      LANG: 'C.UTF-8',
      HOME: '/clean/home',
      TEST_DATABASE_URL: 'postgres://localhost/test',
      // The parent's HOME (`/home/maintainer`) never passes; the test database becomes the app's.
      DATABASE_URL: 'postgres://localhost/test',
    });
  });

  test('an overlay deletes every parent key the clean env lacks, for exec’s merge', () => {
    const clean = strangerEnv(parent, [], {});
    const overlay = asOverlay(parent, clean);
    expect(overlay['NPM_TOKEN']).toBeUndefined();
    expect('NPM_TOKEN' in overlay).toBe(true);
    expect(overlay['PATH']).toBe('/usr/bin');
  });

  test('no allowlisted name is a credential', () => {
    for (const key of STRANGER_KEYS) expect(key).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY|NPM/);
  });

  test('a real child of exec sees no NPM_TOKEN its parent holds', async () => {
    const prior = Bun.env['NPM_TOKEN'];
    Bun.env['NPM_TOKEN'] = 'x';
    const cwd = mkdtempSync(join(tmpdir(), 'stranger-env-'));
    try {
      const env = asOverlay(Bun.env, strangerEnv(Bun.env, [], { HOME: cwd }));
      const result = await exec(
        [process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env)))'],
        { cwd, env },
      );
      const keys: unknown = JSON.parse(result.stdout);
      expect(keys).not.toContain('NPM_TOKEN');
      const allowed = new Set([...STRANGER_KEYS, 'HOME'].map((key) => key.toUpperCase()));
      expect((keys as string[]).filter((key) => !allowed.has(key.toUpperCase()))).toEqual([]);
    } finally {
      if (prior === undefined) delete Bun.env['NPM_TOKEN'];
      else Bun.env['NPM_TOKEN'] = prior;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('the sites’ one call: no secret this process holds, the test-service URLs kept', () => {
    const prior = { token: Bun.env['NPM_TOKEN'], db: Bun.env['TEST_DATABASE_URL'] };
    Bun.env['NPM_TOKEN'] = 'x';
    Bun.env['TEST_DATABASE_URL'] = 'postgres://localhost/test';
    try {
      const env = strangerEnvAt(repoRoot());
      expect(env['NPM_TOKEN']).toBeUndefined();
      expect(env['TEST_DATABASE_URL']).toBe('postgres://localhost/test');
      const overlay = strangerOverlayAt(repoRoot());
      expect('NPM_TOKEN' in overlay && overlay['NPM_TOKEN'] === undefined).toBe(true);
    } finally {
      disposeStrangerHome();
      for (const [key, value] of [
        ['NPM_TOKEN', prior.token],
        ['TEST_DATABASE_URL', prior.db],
      ] as const) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
  });

  /**
   * The spawns that start scaffolded or published code directly. `scaffold-gate.ts`,
   * `scaffold-first-run.ts` and the bench take their env as a parameter, which their own tests
   * hold; these build it at the call, so the call is what is read.
   */
  test('every direct spawn of scaffolded code is handed the stranger env', async () => {
    const sites = [
      'scripts/scaffold-admin.ts',
      'scripts/scaffold-agent.ts',
      'scripts/tutorial-run.ts',
      'scripts/bench/http-hello.ts',
    ];
    const spawns: string[] = [];
    for (const site of sites) {
      const source = await Bun.file(`${repoRoot()}/${site}`).text();
      for (const match of source.matchAll(/Bun\.spawn\(|\brun\(\[/g)) {
        const call = source.slice(match.index, source.indexOf('});', match.index));
        spawns.push(`${site}: ${/\benv: (strangerEnvAt|freshMachine)\(/.test(call) ? 'ok' : call}`);
      }
    }
    expect(spawns.length).toBe(5);
    expect(spawns.filter((line) => !line.endsWith(': ok'))).toEqual([]);
  });

  /** A child's view of its home and its database, through a real spawn with `env` as given. */
  const childSees = async (env: Record<string, string>, cwd: string) => {
    const probe = [
      "const os = require('node:os'); const fs = require('node:fs');",
      "const rc = os.homedir() + '/.npmrc';",
      'console.log(JSON.stringify({ home: os.homedir(), npmrc: fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : null,',
      ' userconfig: process.env.NPM_CONFIG_USERCONFIG ?? null, db: process.env.DATABASE_URL ?? null }));',
    ].join('');
    const child = Bun.spawn([process.execPath, '-e', probe], { cwd, env, stdout: 'pipe' });
    const seen: unknown = JSON.parse(await new Response(child.stdout).text());
    return seen as {
      home: string;
      npmrc: string | null;
      userconfig: string | null;
      db: string | null;
    };
  };

  test('a child never reads the real home’s ~/.npmrc — its home is a throwaway one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stranger-home-test-'));
    try {
      const realHome = join(root, 'real-home');
      mkdirSync(realHome);
      writeFileSync(join(realHome, '.npmrc'), '//registry.npmjs.org/:_authToken=SENTINEL\n');
      const parent = { PATH: Bun.env['PATH'] ?? '', HOME: realHome, USERPROFILE: realHome };
      const env = strangerChild(parent, [], join(root, 'run'));
      const seen = await childSees(env, root);
      expect(seen.npmrc).toBeNull();
      expect(seen.home.startsWith(join(root, 'run'))).toBe(true);
      expect(seen.userconfig).not.toBeNull();
      for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'BUN_INSTALL'])
        expect(env[key]?.startsWith(join(root, 'run')), key).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a parent DATABASE_URL never reaches the child; only TEST_DATABASE_URL becomes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stranger-db-test-'));
    try {
      const prod = { PATH: Bun.env['PATH'] ?? '', DATABASE_URL: 'postgres://prod/real' };
      const services = ['TEST_DATABASE_URL', 'DATABASE_URL'];
      expect((await childSees(strangerChild(prod, services, join(root, 'a')), root)).db).toBeNull();
      const test = { ...prod, TEST_DATABASE_URL: 'postgres://localhost/test' };
      expect((await childSees(strangerChild(test, services, join(root, 'b')), root)).db).toBe(
        'postgres://localhost/test',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
