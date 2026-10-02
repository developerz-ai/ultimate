// One manifest line, added as a text edit: the dependency is declared, and every byte the author
// or their formatter chose outside that block is left exactly as it was.

import { describe, expect, test } from 'bun:test';
import { withDependency } from './workspace-dep-edit';

const MANIFEST = `{
  "name": "@shop/web",
  "files": ["src"],
  "dependencies": {
    "@shop/i18n": "0.0.0"
  }
}
`;

describe('unit · declaring a workspace dependency', () => {
  test('the line lands in key order, and nothing outside the block moves', () => {
    expect(withDependency(MANIFEST, '@shop/db', '0.0.0')).toBe(`{
  "name": "@shop/web",
  "files": ["src"],
  "dependencies": {
    "@shop/db": "0.0.0",
    "@shop/i18n": "0.0.0"
  }
}
`);
  });

  test('a manifest with no dependencies block gains one after its last property', () => {
    const bare = '{\n  "name": "@shop/db",\n  "exports": {\n    ".": "./src/index.ts"\n  }\n}\n';
    expect(withDependency(bare, '@shop/web', '1.2.3')).toBe(
      '{\n  "name": "@shop/db",\n  "exports": {\n    ".": "./src/index.ts"\n  },\n  "dependencies": {\n    "@shop/web": "1.2.3"\n  }\n}\n',
    );
  });

  test('an edge already declared — in any block — is not an edit', () => {
    expect(withDependency(MANIFEST, '@shop/i18n', '0.0.0')).toBeUndefined();
    const dev = '{\n  "name": "a",\n  "devDependencies": {\n    "@shop/db": "0.0.0"\n  }\n}\n';
    expect(withDependency(dev, '@shop/db', '0.0.0')).toBeUndefined();
  });

  test('text that is not a manifest is left for bun install to refuse', () => {
    expect(withDependency('{ not json', '@shop/db', '0.0.0')).toBeUndefined();
    expect(withDependency('[]', '@shop/db', '0.0.0')).toBeUndefined();
    expect(withDependency('{}\n', '@shop/db', '0.0.0')).toBeUndefined();
  });
});
