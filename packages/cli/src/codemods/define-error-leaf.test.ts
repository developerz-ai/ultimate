// 31.4.1: `defineError` is imported from the `@ultimat3/core/page` leaf — the `error-declared`
// guard refuses the barrel. Any app file is rewritten; the rest of an import stays where it was.

import { describe, expect, test } from 'bun:test';
import { memoryCodemodApp } from './codemod';
import { codemod } from './define-error-leaf';

describe('unit · codemod define-error-leaf', () => {
  test('carries 31.4.1', () => {
    expect(codemod.since).toBe('31.4.1');
  });

  test('the barrel import becomes the leaf, in apps/ and packages/, and a second run is nothing', async () => {
    const app = memoryCodemodApp({
      'apps/web/app/post/errors.ts': "// x\nimport { defineError } from '@ultimat3/core';\n",
      'packages/domain/src/index.ts':
        "import { defineError } from '@ultimat3/core';\nconst a = 1;\n",
    });
    const result = await codemod.run(app);
    expect(result.changed.sort()).toEqual([
      'apps/web/app/post/errors.ts',
      'packages/domain/src/index.ts',
    ]);
    expect(app.files['apps/web/app/post/errors.ts']).toBe(
      "// x\nimport { defineError } from '@ultimat3/core/page';\n",
    );
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('beside other names, defineError moves to its own leaf import and the rest stay', async () => {
    const app = memoryCodemodApp({
      'apps/web/a.ts': "import { type Actor, defineError, logger } from '@ultimat3/core';\n",
    });
    await codemod.run(app);
    expect(app.files['apps/web/a.ts']).toBe(
      "import { type Actor, logger } from '@ultimat3/core';\nimport { defineError } from '@ultimat3/core/page';\n",
    );
  });

  test('a file that only names it, or imports something else, or lives in node_modules, is untouched', async () => {
    const files = {
      'apps/web/b.ts': "import { logger } from '@ultimat3/core';\n// defineError\n",
      'packages/x/node_modules/y/c.ts': "import { defineError } from '@ultimat3/core';\n",
    };
    const app = memoryCodemodApp({ ...files });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual(files);
  });
});
