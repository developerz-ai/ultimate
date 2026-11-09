// The Dependabot config `x new` writes. The failure it exists for: an adopter's Dependabot bumped
// ONE `@ultimat3/*` package, broke the lockstep every release is cut in, and the app went red on
// an install no human chose. Asserted against the emitted files, never against a retyped list.

import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { names } from '../naming';
import { docsFiles } from '../scaffold-docs';
import { DEPENDABOT_PATH } from './dependabot.yml';

interface Update {
  readonly 'package-ecosystem'?: string;
  readonly directory?: string;
  readonly directories?: readonly string[];
  readonly groups?: Readonly<
    Record<
      string,
      {
        readonly patterns?: readonly string[];
        readonly 'exclude-patterns'?: readonly string[];
        readonly 'update-types'?: unknown;
      }
    >
  >;
}

const app = names('ledger-demo');

const config = (): { readonly version?: number; readonly updates?: readonly Update[] } => {
  const file = docsFiles(app).find((entry) => entry.path === DEPENDABOT_PATH);
  if (file === undefined || typeof file.contents !== 'string') {
    return expect.unreachable(`x new writes no ${DEPENDABOT_PATH}`);
  }
  return YAML.parse(file.contents) as { version?: number; updates?: readonly Update[] };
};

const ecosystem = (name: string): Update => {
  const found = config().updates?.find((update) => update['package-ecosystem'] === name);
  return found ?? expect.unreachable(`no ${name} entry`);
};

describe('unit · the dependabot.yml x new writes', () => {
  test('is version 2, on bun (the tree is locked by bun.lock alone)', () => {
    expect(config().version).toBe(2);
    expect(ecosystem('bun').directory).toBe('/');
  });

  test('moves every framework package together, majors included, in ONE group', () => {
    const groups = Object.values(ecosystem('bun').groups ?? {});
    const framework = groups.filter((group) => group.patterns?.includes('@ultimat3/*'));
    expect(framework).toHaveLength(1);
    // No `update-types` filter: one omitted type is a type Dependabot bumps package by package.
    expect(framework[0]).toEqual({ patterns: ['@ultimat3/*', 'create-ultimate'] });
  });

  test('no other bun group can claim a framework package', () => {
    const others = Object.values(ecosystem('bun').groups ?? {}).filter(
      (group) => !group.patterns?.includes('@ultimat3/*'),
    );
    for (const group of others) {
      if (!group.patterns?.includes('*')) continue;
      expect(group['exclude-patterns']).toEqual(['@ultimat3/*', 'create-ultimate']);
    }
  });

  test('watches the directory the scaffold pins its images in', () => {
    const dockerDirs = [
      ...new Set(
        docsFiles(app)
          .map((file) => file.path)
          .filter((path) => /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/.test(path))
          .map((path) => `/${path.split('/').slice(0, -1).join('/')}`),
      ),
    ];
    expect(dockerDirs.length).toBeGreaterThan(0);
    expect(ecosystem('docker').directories).toEqual(dockerDirs);
    expect(ecosystem('docker-compose').directories).toEqual(dockerDirs);
  });

  test('watches the workflows x new writes', () => {
    expect(ecosystem('github-actions').directory).toBe('/');
  });
});
