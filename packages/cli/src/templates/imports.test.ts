import { describe, expect, test } from 'bun:test';
import { sortedImports } from './imports';

describe('sortedImports', () => {
  test('puts the app scope where its own name says, not where the template author guessed', () => {
    const framework = `import { defineRoute } from '@ultimat3/render';`;
    // The two halves of the bug: one app scope sorts before `@ultimat3`, the next sorts after, and
    // a fixed order in the template is wrong for exactly one of them.
    expect(sortedImports([`import { useT } from '@zebra/i18n';`, framework])).toBe(
      `${framework}\nimport { useT } from '@zebra/i18n';`,
    );
    expect(sortedImports([`import { useT } from '@alpha/i18n';`, framework])).toBe(
      `import { useT } from '@alpha/i18n';\n${framework}`,
    );
  });

  test('orders by the specifier and never by what the line imports', () => {
    // `registerActions` sorts before `defineAppMcp` and `@ultimat3/action` after `@ultimat3/mcp`
    // would be wrong: the line's text is not the key, the quoted module is.
    expect(
      sortedImports([
        `import { defineAppMcp } from '@ultimat3/mcp';`,
        `import { registerActions } from '@ultimat3/action';`,
      ]),
    ).toBe(
      `import { registerActions } from '@ultimat3/action';\nimport { defineAppMcp } from '@ultimat3/mcp';`,
    );
  });

  test('an already-sorted block is returned unchanged, so a template that was right stays right', () => {
    const block = [
      `import { registerActions } from '@ultimat3/action';`,
      `import { defineRoute } from '@ultimat3/render';`,
    ];
    expect(sortedImports(block)).toBe(block.join('\n'));
  });
});
