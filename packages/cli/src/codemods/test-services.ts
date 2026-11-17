// 31.41.0: an app scaffolded before 31.27.0 gains the test-services stack `test-suites` and the
// `live` floor assume — `docker/docker-compose.test.yml` and `docker/test-services.env`, as `x new`
// writes them, under this app's own ports. A file the app already holds is its own.

import { names } from '../templates/naming';
import { testServicesFiles } from '../templates/scaffold-test-services';
import { appName } from './agents-dev-mcp';
import type { Codemod, CodemodResult } from './codemod';
import { mergeResults, readText, writeIfAbsent } from './engine-edits';

/** The live suite's host: an app with no db package has nothing for a test service to serve. */
const DB_HOST = 'packages/db/src/index.ts';

export const codemod: Codemod = {
  id: 'test-services',
  since: '31.41.0',
  summary:
    'the test-services stack a live suite needs, for an app scaffolded before it: docker/docker-compose.test.yml and docker/test-services.env',
  async run(app) {
    if (!(await app.exists(DB_HOST))) return { changed: [], skipped: [] };
    const kebab = appName((await readText(app, 'package.json'))?.text ?? '');
    if (kebab === undefined) return { changed: [], skipped: [] };
    const results: CodemodResult[] = [];
    for (const file of testServicesFiles(names(kebab))) {
      if (typeof file.contents === 'string') {
        results.push(await writeIfAbsent(app, file.path, file.contents));
      }
    }
    return mergeResults(results);
  },
};
