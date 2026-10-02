// The edit `x g resource --admin` makes to the app's admin, as a pure function over its source:
// the override is listed under `resources:` — created when the call has none — and a file that is
// not a `defineAdmin({ … })` is refused with the two lines rather than guessed at.

import { describe, expect, test } from 'bun:test';
import type { AdminResourceEntry } from './admin-registration';
import {
  ADMIN_FILE,
  adminResourceUnwiredFinding,
  insertAdminResources,
  withAdminResources,
} from './admin-registration';

const entry = (name: string): AdminResourceEntry => ({
  table: `${name}s`,
  binding: `${name}AdminResource`,
  specifier: `@shop/web/app/${name}/admin/resource`,
});

const ADMIN = `import { db } from '@shop/db';
import { adminEntitiesOf, defineAdmin } from '@ultimat3/admin';

export const admin = defineAdmin({
  entities: adminEntitiesOf(db),
  db,
  // Per-entity overrides go in \`resources: { <entity>: … }\`.
});
`;

describe('unit · listing an override in defineAdmin()', () => {
  test('a call with no resources: gains the block last, and the import in sorted position', () => {
    const { source, missing } = insertAdminResources(ADMIN, [entry('widget')]);
    expect(missing).toEqual([]);
    expect(source).toContain(
      "import { db } from '@shop/db';\nimport { widgetAdminResource } from '@shop/web/app/widget/admin/resource';\nimport { adminEntitiesOf",
    );
    // After the comment that names the key: that comment is prose, never mistaken for the key.
    expect(source).toContain(
      '  // Per-entity overrides go in `resources: { <entity>: … }`.\n  resources: {\n    widgets: widgetAdminResource,\n  },\n});\n',
    );
  });

  test('a brace in a comment is prose: the call is still found, and closed where it closes', () => {
    const stray = ADMIN.replace('  db,\n', '  db,\n  // `resources: {` opens the block.\n');
    const { source, missing } = insertAdminResources(stray, [entry('widget')]);
    expect(missing).toEqual([]);
    expect(source).toEndWith('  resources: {\n    widgets: widgetAdminResource,\n  },\n});\n');
  });

  test('a second override joins the block in key order, and a repeat changes nothing', () => {
    const once = insertAdminResources(ADMIN, [entry('widget')]).source;
    const twice = insertAdminResources(once, [entry('gadget')]).source;
    expect(twice).toContain(
      '  resources: {\n    gadgets: gadgetAdminResource,\n    widgets: widgetAdminResource,\n  },',
    );
    expect(insertAdminResources(twice, [entry('gadget'), entry('widget')]).source).toBe(twice);
  });

  test('a one-line resources: is expanded rather than grown sideways', () => {
    const inline = ADMIN.replace('  db,\n', '  db,\n  resources: { posts: postAdminResource },\n');
    expect(insertAdminResources(inline, [entry('widget')]).source).toContain(
      '  resources: {\n    posts: postAdminResource,\n    widgets: widgetAdminResource,\n  },',
    );
  });

  test('a file with no defineAdmin({ … }) is not guessed at: the finding carries both lines', () => {
    const other = 'export const admin = buildAdmin(options);\n';
    expect(insertAdminResources(other, [entry('widget')])).toEqual({
      source: other,
      missing: [entry('widget')],
    });
    const finding = adminResourceUnwiredFinding(entry('widget'), 'holds no call');
    expect(finding.code).toBe('X_ADMIN_RESOURCE_UNWIRED');
    expect(finding.at).toBe(ADMIN_FILE);
    expect(finding.fix).toContain(
      "import { widgetAdminResource } from '@shop/web/app/widget/admin/resource';",
    );
    expect(finding.fix).toContain('resources: { widgets: widgetAdminResource }');
  });

  test('a file list is wired the way the disk is, keyed by the entity own name', () => {
    const files = withAdminResources(
      [
        { path: ADMIN_FILE, contents: ADMIN },
        {
          path: 'apps/web/app/credit-note/entity.ts',
          contents: "export const creditNote = entity('credit_notes', { columns: {} });\n",
        },
        {
          path: 'apps/web/app/credit-note/admin/resource.ts',
          contents: 'export const creditNoteAdminResource = { pageSize: 25 };\n',
        },
        // An override with no entity beside it names no table, so it is not listed.
        {
          path: 'apps/web/app/orphan/admin/resource.ts',
          contents: 'export const orphanAdminResource = {};\n',
        },
      ],
      '@shop/web',
    );
    const admin = String(files.find((file) => file.path === ADMIN_FILE)?.contents);
    expect(admin).toContain('    credit_notes: creditNoteAdminResource,');
    expect(admin).toContain("from '@shop/web/app/credit-note/admin/resource';");
    expect(admin).not.toContain('orphan');
  });
});
