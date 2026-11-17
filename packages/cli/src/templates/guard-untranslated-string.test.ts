// The `untranslated-string` guard as `x new` emits it, run through the gate's own seam: typed prose
// is refused wherever an app renders it, `apps/*/shared` included.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const PROSE = 'export const A = () => <p>Hello there</p>;\n';

describe('unit · shipped guard · untranslated-string', () => {
  test('typed prose is refused in site/, app/, shared/ and a package', async () => {
    const findings = await shippedGuardFindings('untranslated-string', {
      'apps/web/site/a.tsx': PROSE,
      'apps/web/app/b.tsx': PROSE,
      'apps/web/shared/c.tsx': PROSE,
      'packages/ui/src/d.tsx': PROSE,
      'apps/web/shared/c.test.tsx': PROSE,
    });
    expect(findings.map((finding) => finding.at?.split(':')[0]).sort()).toEqual([
      'apps/web/app/b.tsx',
      'apps/web/shared/c.tsx',
      'apps/web/site/a.tsx',
      'packages/ui/src/d.tsx',
    ]);
  });

  // A label a screen reader speaks, a tooltip, a placeholder and an alt text are rendered strings
  // too: `aria-label="Download report"` used to pass while the same words between tags did not.
  test('a typed user-facing attribute is refused, and the finding names it', async () => {
    const findings = await shippedGuardFindings('untranslated-string', {
      'apps/web/app/a.tsx': 'export const A = () => <button aria-label="Download report" />;\n',
      'apps/web/app/b.tsx': "export const B = () => <img alt='A red bicycle' src={src} />;\n",
      'apps/web/site/c.tsx': "export const C = () => <input placeholder={'Search posts'} />;\n",
      'apps/web/shared/d.tsx': 'export const D = () => <abbr title="Coordinated time" />;\n',
      'packages/ui/src/e.tsx': 'export const E = () => <div aria-description="Opens a menu" />;\n',
    });
    expect(findings.map((finding) => finding.at).sort()).toEqual([
      'apps/web/app/a.tsx',
      'apps/web/app/b.tsx',
      'apps/web/shared/d.tsx',
      'apps/web/site/c.tsx',
      'packages/ui/src/e.tsx',
    ]);
    const label = findings.find((finding) => finding.at === 'apps/web/app/a.tsx');
    expect(label?.cause).toContain('aria-label');
    expect(label?.cause).toContain('Download report');
    expect(label?.fix).toContain("aria-label={t('");
  });

  // `x i18n check` audits catalogs, never pages: it passes with the string still typed, so a fix
  // ending there declares done what this guard still refuses. The guard runs on `boundaries`.
  test('both fixes end with the check that refuses the typed string, never x i18n check', async () => {
    const findings = await shippedGuardFindings('untranslated-string', {
      'apps/web/app/a.tsx': PROSE,
      'apps/web/app/b.tsx': 'export const B = () => <button aria-label="Download report" />;\n',
    });
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.fix).toEndWith('then: x verify --only boundaries');
      expect(finding.fix).not.toContain('x i18n check');
    }
  });

  // The lookalikes: a t() call, an expression, an empty decorative alt, a token-sized value, an
  // attribute that only ends in a listed name, a variable assignment, and a test file.
  test('a t() call, an expression, a non-text value and a test file are not reported', async () => {
    const findings = await shippedGuardFindings('untranslated-string', {
      'apps/web/app/a.tsx': [
        "export const A = () => <button aria-label={t('app.report.download')} />;",
        'export const B = (p: { label: string }) => <input placeholder={p.label} alt="" />;',
        'export const C = () => <i data-title="Not rendered" title="x" />;',
        "export const D = () => { const title = 'Plain variable'; return title; };",
        '',
      ].join('\n'),
      'apps/web/app/e.test.tsx':
        'export const E = () => <button aria-label="Download report" />;\n',
    });
    expect(findings).toEqual([]);
  });
});
