// An app scaffolded before 31.27.0 holds no test-services stack, yet `test-suites` hands it a `live`
// suite and the floor requires `live`: six adopter upgrades wrote the two files by hand from the
// template function (round 3). This codemod writes them as `x new` does today.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates/naming';
import {
  TEST_COMPOSE_PATH,
  TEST_ENV_PATH,
  testServicesFiles,
} from '../templates/scaffold-test-services';
import { memoryCodemodApp } from './codemod';
import { codemod } from './test-services';

const OLD_APP = {
  'package.json': JSON.stringify({ name: 'old-app', private: true }),
  'packages/db/src/index.ts': 'export {};\n',
};

const today = (path: string): string => {
  const file = testServicesFiles(names('old-app')).find((one) => one.path === path);
  return typeof file?.contents === 'string' ? file.contents : expect.unreachable(`no ${path}`);
};

describe('unit · codemod test-services', () => {
  test('an app with a database and no stack gains both files, as x new writes them', async () => {
    const app = memoryCodemodApp({ ...OLD_APP });
    const result = await codemod.run(app);
    expect(result.changed.sort()).toEqual([TEST_COMPOSE_PATH, TEST_ENV_PATH].sort());
    expect(app.files[TEST_COMPOSE_PATH]).toBe(today(TEST_COMPOSE_PATH));
    expect(app.files[TEST_ENV_PATH]).toBe(today(TEST_ENV_PATH));
  });

  test('a second run changes nothing, and a file the app holds is its own', async () => {
    const app = memoryCodemodApp({ ...OLD_APP, [TEST_ENV_PATH]: '# mine\n' });
    const first = await codemod.run(app);
    expect(first.changed).toEqual([TEST_COMPOSE_PATH]);
    expect(app.files[TEST_ENV_PATH]).toBe('# mine\n');
    expect((await codemod.run(app)).changed).toEqual([]);
  });

  test('an app with no database, or no usable name, is left alone', async () => {
    const noDb = memoryCodemodApp({ 'package.json': OLD_APP['package.json'] });
    expect((await codemod.run(noDb)).changed).toEqual([]);
    const noName = memoryCodemodApp({ ...OLD_APP, 'package.json': '{}' });
    expect((await codemod.run(noName)).changed).toEqual([]);
  });
});
