// Which sources await at their top level: parsed, so every spelling of a top-level await is found
// and an await inside any function is not.

import { describe, expect, test } from 'bun:test';
import { hasTopLevelAwait } from './app-load-async';

const awaits = (source: string, path = 'apps/web/app/a/mod.ts'): boolean =>
  hasTopLevelAwait(path, source);

describe('unit · hasTopLevelAwait', () => {
  test('every spelling of a top-level await', () => {
    expect(awaits('const rows = await load();\n')).toBe(true);
    expect(awaits('await (ready);\n')).toBe(true);
    // Inside a plain function `await [x]` parses as indexing a variable named `await`: the reason
    // the check is a static block, where the word is reserved.
    expect(awaits('await [ready];\n')).toBe(true);
    expect(awaits('for await (const row of rows) { void row; }\n')).toBe(true);
    expect(awaits('if (flag) { await settle(); }\n')).toBe(true);
    expect(awaits("import { x } from './x';\nexport const y: number = await x();\n")).toBe(true);
  });

  test('an await inside a function, a method or an arrow is not one', () => {
    const source = `import type { Row } from './row';
import { load } from './load';
export async function run(): Promise<Row[]> { return await load(); }
export const arrow = async () => { await load(); };
export class Repo { async all() { await load(); } }
export default async function Page() { await load(); }
export { load };
export const meta = import.meta.url;
`;
    expect(awaits(source)).toBe(false);
    expect(awaits('export const Page = () => <main>{"await"}</main>;\n', 'page.tsx')).toBe(false);
  });

  test('a source with no await at all is answered without a parse', () => {
    expect(awaits('this is not TypeScript at all')).toBe(false);
  });
});
