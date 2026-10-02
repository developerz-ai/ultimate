// Axiom 6, in bytes: an app that declares an admin serves its static `site/` documents with ZERO
// bytes of the admin's stylesheet. The admin's screens are served on `app/`, so its package sheets
// are claimed for that surface — a package sheet nobody claims rides both graphs, which is how
// every marketing page came to carry 4.8 kB of dashboard chrome.

import { describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';

const { loadStylesheet, registeredStylesheets, stylesFor } = await import(
  '@ultimat3/render/server'
);
const { defineAdmin } = await import('./admin');
// The screens, and with them every stylesheet the admin's views import.
await import('./routes');

const SHEET = `${import.meta.dir}/admin.module.scss`;

describe('unit · the admin’s stylesheets belong to the app surface', () => {
  test('a site document of an app that declares an admin carries zero admin CSS bytes', async () => {
    const things = entity('admin_css_things', {
      columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
    });
    defineAdmin({
      basePath: '/css-admin',
      entities: [things],
      db: database({ things }, { driver: memoryDriver() }),
    });
    // Registered the way the loader registers it when a view imports it — and explicitly, so
    // this holds whichever test file in the process cleared the registry before this one ran.
    loadStylesheet(SHEET, await Bun.file(SHEET).text());

    const own = registeredStylesheets().filter((sheet) => sheet.file.startsWith(import.meta.dir));
    expect(own.length).toBeGreaterThan(0);
    for (const sheet of own) {
      expect({ file: sheet.file, surface: sheet.surface }).toEqual({
        file: sheet.file,
        surface: 'app',
      });
    }

    const site = stylesFor('site');
    const app = stylesFor('app');
    const bytes = own.reduce((total, sheet) => total + sheet.css.length, 0);
    expect(bytes).toBeGreaterThan(1000);
    for (const sheet of own) {
      // Not one rule of it: the whole sheet is absent from what a site document links.
      expect(site.includes(sheet.css)).toBe(false);
      expect(app.includes(sheet.css)).toBe(true);
    }
    // The admin's own class names are content-hashed per file; none of them is in the site CSS.
    const shell = /\.(shell_[0-9a-f]+)/.exec(own.map((sheet) => sheet.css).join(''))?.[1] ?? '';
    expect(shell).not.toBe('');
    expect(site).not.toContain(shell);
    clearRegistry();
  });
});
