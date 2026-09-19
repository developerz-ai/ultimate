// The two error pages, held to what makes them safe to serve verbatim: a complete document, no
// index, a way home, and one `<style>` body the boot can hash — and the same two hex values the
// PWA colours in `app.config.ts` carry, so the splash and the error page cannot drift apart.
import { describe, expect, test } from 'bun:test';
import { inlineStyleBodies } from '../error-page-csp';
import { names } from './naming';
import { errorPageFiles, PWA_COLORS } from './scaffold-errors';
import { repoFiles } from './scaffold-repo';

const app = names('ledger-demo');

const text = (contents: string | Uint8Array): string =>
  typeof contents === 'string' ? contents : expect.unreachable('an error page is text');

describe('unit · the scaffolded error pages', () => {
  test('one page per status, each a complete document that refuses indexing', () => {
    const files = errorPageFiles(app);
    expect(files.map((file) => file.path)).toEqual([
      'apps/web/site/errors/404.html',
      'apps/web/site/errors/500.html',
    ]);
    for (const file of files) {
      const html = text(file.contents);
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('href="/"');
      // Self-contained: nothing linked, nothing scripted.
      expect(html).not.toContain('<link');
      expect(html).not.toContain('<script');
    }
  });

  test('each page carries exactly one <style> body, the one the boot hashes into style-src', () => {
    for (const file of errorPageFiles(app)) {
      const bodies = inlineStyleBodies(text(file.contents));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('prefers-color-scheme: light');
      expect(bodies[0]).toContain(PWA_COLORS.darkBackground);
      expect(bodies[0]).toContain(PWA_COLORS.lightBackground);
    }
  });

  test('the colours are the ones app.config.ts declares for the PWA splash', () => {
    const config = repoFiles(app, '1.0.0', true).find((file) => file.path === 'app.config.ts');
    const source = text(config?.contents ?? expect.unreachable('x new writes no app.config.ts'));
    expect(source).toContain(`themeColor: '${PWA_COLORS.themeColor}'`);
    expect(source).toContain(`backgroundColor: '${PWA_COLORS.lightBackground}'`);
    expect(source).toContain(`backgroundColor: '${PWA_COLORS.darkBackground}'`);
    // The title names the status page's app, and the two titles differ — a duplicate title is
    // what the seo step refuses on rendered routes, and these files never reach it.
    const titles = errorPageFiles(app).map(
      (file) => /<title>([^<]*)<\/title>/.exec(text(file.contents))?.[1],
    );
    expect(new Set(titles).size).toBe(2);
  });
});
