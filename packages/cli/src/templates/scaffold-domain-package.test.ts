// The generated `packages/domain` holds only what something reads. It shipped a `ROLES` list
// (`owner`, `member`, `viewer`) nothing imported, beside the app's real role map in
// `apps/web/shared/roles.ts` (`member`, `admin`): a second answer to "which roles exist", and the
// wrong one, in the file an agent is told holds the app's constants.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';
import { names } from './naming';
import { domainPackageFiles } from './scaffold-domain-package';

const APP = 'ledger-demo';

const textOf = (path: string): string => {
  const found = domainPackageFiles(names(APP)).find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`no generated ${path}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

/** Every name the domain index declares and exports — a re-export is another package's name. */
const declaredExports = (source: string): readonly string[] =>
  [...source.matchAll(/^export (?:const|class|function|type|interface) (\w+)/gm)].map(
    (match) => match[1] ?? '',
  );

describe('unit · the scaffolded domain package', () => {
  test('declares no role list: the roles are apps/web/shared/roles.ts`s, once', () => {
    const exported = declaredExports(textOf('packages/domain/src/index.ts'));
    expect(exported).not.toContain('ROLES');
    expect(exported).not.toContain('Role');
  });

  // A dead export is a constant an agent finds, trusts and builds on. Imported by the package's own
  // test or by another file `x new` writes — with and without `--example` — or it does not ship.
  test('every name it exports is read by something the scaffold writes', () => {
    const exported = declaredExports(textOf('packages/domain/src/index.ts'));
    expect(exported.length).toBeGreaterThan(0);
    for (const example of [false, true]) {
      const readers = planNewApp({ name: APP, example })
        .filter((file) => file.path !== 'packages/domain/src/index.ts')
        .map((file) => (typeof file.contents === 'string' ? file.contents : ''))
        .join('\n');
      // IMPORTED, not merely spelt: `add` and `zero` are words every comment uses.
      const unread = exported.filter(
        (name) =>
          !new RegExp(`import [^;]*\\b${name}\\b[^;]* from '(\\./index|@${APP}/domain)'`).test(
            readers,
          ),
      );
      expect({ example, unread }).toEqual({ example, unread: [] });
    }
  });
});
