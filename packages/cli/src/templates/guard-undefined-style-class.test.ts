// The `undefined-style-class` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';
const PAGE = 'apps/web/site/page.tsx';

const page = (read: string): string =>
  `import styles from './page.module.scss';\nexport const Page = () => <h1 class={${read}} />;\n`;

describe('unit · shipped guard · undefined-style-class', () => {
  test('a class the sheet does not compile is X_UNDEFINED_STYLE_CLASS, with the line', async () => {
    const findings = await shippedGuardFindings('undefined-style-class', {
      [SHEET]: '.hero {\n  color: inherit;\n}\n',
      [PAGE]: page('styles.missing'),
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_UNDEFINED_STYLE_CLASS']);
    expect(findings[0]?.at).toBe(`${PAGE}:2`);
    expect(findings[0]?.cause).toContain(`${SHEET} compiles no class \`missing\``);
  });

  test('a near miss names the class the sheet does compile', async () => {
    const findings = await shippedGuardFindings('undefined-style-class', {
      [SHEET]: '.hero-title {\n  color: inherit;\n}\n',
      [PAGE]: page("styles['heroTitle']"),
    });
    expect(findings[0]?.fix).toStartWith("styles['hero-title'] — ");
  });

  // The reason this guard compiles: a nested `&-suffix`, a class a framework MIXIN emits and a
  // `:global()` selector are all invisible to a scan of the source.
  test('the COMPILED class list decides: nesting and a mixin count, :global() does not', async () => {
    const scss = [
      "@use '@ultimat3/ui/tokens' as tokens;",
      '@include tokens.tone-classes;',
      '.card {',
      '  &-title { color: inherit; }',
      '}',
      ':global(.plain) { color: inherit; }',
      '',
    ].join('\n');
    const reads = "[styles['card-title'], styles['tone-danger'], styles.plain].join(' ')";
    const findings = await shippedGuardFindings(
      'undefined-style-class',
      { [SHEET]: scss, [PAGE]: page(reads) },
      { ui: true },
    );
    expect(findings.map((finding) => finding.cause.split(' reads ')[1]?.split(',')[0])).toEqual([
      'styles.plain',
    ]);
  });

  test("a computed key is out of scope, and a sheet that does not compile is the build's", async () => {
    expect(
      await shippedGuardFindings('undefined-style-class', {
        [SHEET]: '.hero { color: inherit; }\n',
        [PAGE]: page('styles[props.tone]'),
      }),
    ).toEqual([]);
    expect(
      await shippedGuardFindings('undefined-style-class', {
        [SHEET]: '.hero { color: ; \n',
        [PAGE]: page('styles.anything'),
      }),
    ).toEqual([]);
  });
});
