// No shipped guard's `fix:` may name an import another shipped guard refuses. 31.4.1 shipped one:
// `bare-error` told an app to take `defineError` "from @ultimat3/core", the barrel `error-declared`
// refuses — so following one guard's fix tripped the other. Each fix's imports are rebuilt as code
// and run through every shipped guard, the way `x verify`'s `boundaries` step runs them.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `node:fs/promises` is the only one.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { guardFindings } from '../guards';
import { SHIPPED_GUARD_NAMES, shippedGuardFiles, shippedGuardSource } from './scaffold-guards';
import { linkUi } from './shipped-guard-fixture';

/** A `fix:` value, up to the next property or the object's close: a conditional holds several. */
const FIX_VALUE = /\bfix:([\s\S]*?)(?=\n\s*(?:[A-Za-z]+:|\}))/g;
/** A string literal — backtick, single or double quoted. */
const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/** `import { a } from 'b'`, written out in a fix. */
const IMPORT_STATEMENT = /\bimport\s*\{[^}]*\}\s*from\s*'[^']+'/g;
/** Prose naming an import: `defineError({ … }) from @ultimat3/core/page`, `<ConfirmDialog> from '@ultimat3/ui'`. */
const NAMED_FROM = /<?([A-Za-z_$][\w$]*)(?:\([^)]*\))?>?\s+from\s+'?(@ultimat3\/[\w/-]*[\w])'?/g;

/** Each shipped guard's fix texts, by guard name. */
const fixesByGuard = (): readonly (readonly [string, readonly string[]])[] =>
  SHIPPED_GUARD_NAMES.map((name) => {
    const source = shippedGuardSource(name) ?? '';
    const values = [...source.matchAll(FIX_VALUE)].map((match) => match[1] ?? '');
    return [name, values.flatMap((value) => value.match(LITERAL) ?? [])] as const;
  });

/** The import statements a fix tells an app to write, as source a guard can read. */
const fixImports = (fix: string): readonly string[] => [
  ...[...fix.matchAll(IMPORT_STATEMENT)].map((match) => `${match[0]};`),
  ...[...fix.matchAll(NAMED_FROM)].map((match) => `import { ${match[1]} } from '${match[2]}';`),
];

describe('a shipped guard`s fix never trips another shipped guard', () => {
  test('every shipped guard is read, and the import-naming fixes are found', () => {
    const fixes = fixesByGuard();
    expect(fixes.every(([, texts]) => texts.length > 0)).toBe(true);
    const imports = fixes.flatMap(([, texts]) => texts.flatMap(fixImports));
    // Non-vacuous: bare-error, error-declared, native-confirm, raw-fetch and raw-interval name one.
    expect(imports).toContain("import { defineError } from '@ultimat3/core/page';");
    expect(imports).toContain("import { ConfirmDialog } from '@ultimat3/ui';");
  });

  test('no fix takes defineError from the @ultimat3/core barrel — error-declared refuses it', () => {
    const barrel = /defineError\b[^—]*?\bfrom\s+'?@ultimat3\/core(?![\w/-])/;
    const offenders = fixesByGuard().flatMap(([name, texts]) =>
      texts.filter((text) => barrel.test(text)).map((text) => `${name}: ${text}`),
    );
    expect(offenders).toEqual([]);
  });

  test('the imports every fix names pass every shipped guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-guard-fixes-'));
    try {
      for (const name of SHIPPED_GUARD_NAMES) {
        for (const file of shippedGuardFiles(name) ?? []) {
          if (!file.path.endsWith('.test.ts'))
            await Bun.write(join(root, file.path), file.contents);
        }
      }
      await linkUi(root);
      const offenders: string[] = [];
      for (const [name, texts] of fixesByGuard()) {
        const imports = [...new Set(texts.flatMap(fixImports))];
        if (imports.length === 0) continue;
        const path = `apps/web/app/fix-of-${name}.ts`;
        await Bun.write(join(root, path), `${imports.join('\n')}\n`);
        offenders.push(
          ...(await guardFindings(root))
            .filter((finding) => finding.at === path || finding.cause.includes(path))
            .map((finding) => `${name}'s fix → ${finding.code}: ${finding.cause}`),
        );
        await rm(join(root, path));
      }
      expect(offenders).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
