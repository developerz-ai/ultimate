// `AdminAction.when(row)` decides the button on the detail page and on each list row, and the
// server asks it AGAIN before the handler runs: a hidden button is not an authorization. An action
// with an input schema renders it as its own form and maps the schema's refusal back to fields; one
// with none is a confirm only. One declaration, and it is still one MCP tool.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, generateMasterKey, runWithContext, userActor } from '@ultimat3/core';
import {
  boolean,
  clearRegistry,
  database,
  entity,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');
const { callAdminTool } = await import('./mcp');
const { adminToolCatalog } = await import('./mcp-tools');

const KEY_ENV = 'ULTIMATE_SECRETS_KEY';
const previousKey = process.env[KEY_ENV];
const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const widgets = entity('admin_when_widgets', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    active: boolean().default(false),
    secret: text({ max: 80 }).sealed().nullable(),
  },
});

const db = database({ widgets }, { driver: memoryDriver() });
const ran: string[] = [];
const seenByWhen: unknown[] = [];

let admin: AdminApp;
beforeAll(() => {
  admin = defineAdmin({
    basePath: '/when',
    entities: [widgets],
    db,
    actions: [
      {
        name: 'widget.activate',
        permission: 'admin_when_widgets:write',
        entity: 'admin_when_widgets',
        when: (row) => {
          seenByWhen.push(row);
          return row['active'] !== true;
        },
        batch: true,
        handle: async ({ input }) => {
          ran.push(`activate:${String(input['id'])}`);
          await db.widgets.update(String(input['id']), { active: true });
        },
      },
      {
        name: 'widget.rename',
        permission: 'admin_when_widgets:write',
        entity: 'admin_when_widgets',
        input: t.object({ title: t.string.min(3), loud: t.boolean }),
        handle: async ({ input }) => {
          ran.push(
            `rename:${String(input['id'])}:${String(input['title'])}:${String(input['loud'])}`,
          );
        },
      },
    ],
  });
});

registerCatalog('en', {
  'admin.admin_when_widgets.title': 'Widgets',
  'admin.admin_when_widgets.field.title': 'Title',
  'admin.admin_when_widgets.field.active': 'Active',
  'admin.action.widget.activate': 'ACTIVATE-BUTTON',
  'admin.action.widget.rename': 'RENAME-BUTTON',
  'admin.input.widget.rename.title': 'NEW-TITLE-LABEL',
  'admin.input.widget.rename.loud': 'LOUD-LABEL',
});

const OPERATOR: AdminActor = { id: 'u-op', roles: ['when-operator'] };
const BASE = '/when/admin_when_widgets';
const ids = { idle: '', active: '' };

beforeAll(async () => {
  process.env[KEY_ENV] = generateMasterKey();
  defineRoles({
    ...previousRoles,
    'when-operator': {
      grants: ['admin:read', 'admin:write', 'admin_when_widgets:read', 'admin_when_widgets:write'],
    },
  });
  ids.idle = String((await db.widgets.insert({ title: 'Idle one', secret: 'CANARY-1' })).id);
  ids.active = String((await db.widgets.insert({ title: 'Busy one', active: true })).id);
});

afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

const ctx = () => admin.ctx({ actor: OPERATOR, requestId: 'when' });

const ask = (
  path: string,
  form: Readonly<Record<string, unknown>> | null = null,
): Promise<{ response: AdminRouteResponse; html: string }> =>
  runWithContext(
    createContext({ actor: userActor({ id: OPERATOR.id, roles: [...(OPERATOR.roles ?? [])] }) }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no route at ${path}`);
      const response = await matched.route.respond({
        ctx: ctx(),
        params: matched.params,
        url,
        method: form === null ? 'GET' : 'POST',
        form,
      });
      const html =
        response.kind === 'document'
          ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
          : '';
      return { response, html };
    },
  );

const status = (answer: { response: AdminRouteResponse }): number | string =>
  answer.response.kind === 'document' ? answer.response.status : answer.response.location;

describe('unit · when(row) decides the button', () => {
  test('on the detail page: shown on a row it applies to, absent on one it does not', async () => {
    expect((await ask(`${BASE}/${ids.idle}`)).html).toContain('ACTIVATE-BUTTON');
    expect((await ask(`${BASE}/${ids.active}`)).html).not.toContain('ACTIVATE-BUTTON');
  });

  test('on each list row — and the row it reads carries no sealed value', async () => {
    seenByWhen.length = 0;
    const list = await ask(BASE);
    // One per row: the idle row's button form, none for the active row.
    expect(list.html.split('value="widget.activate"').length - 1).toBe(
      // the row form, plus the batch bar's option
      2,
    );
    expect(seenByWhen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seenByWhen)).not.toContain('CANARY');
  });
});

describe('unit · when(row) is asked again on the server', () => {
  test('a forged post for a row it excludes is 409 X_ADMIN_ACTION_NOT_APPLICABLE, and nothing runs', async () => {
    const before = ran.length;
    const forged = await ask(`${BASE}/${ids.active}`, {
      _operation: 'action',
      name: 'widget.activate',
    });
    expect(status(forged)).toBe(409);
    expect(forged.html).toContain('X_ADMIN_ACTION_NOT_APPLICABLE');
    expect(ran.length).toBe(before);
    const entry = (await admin.audit.entries({ entity: 'admin_when_widgets' }))[0];
    expect(entry).toMatchObject({
      operation: 'widget.activate',
      entityId: ids.active,
      outcome: 'denied',
      reason: 'admin.error.action-not-applicable',
    });
  });

  test('the MCP tool refuses with the same code, and is ONE tool for the button and the batch', async () => {
    const tools = adminToolCatalog(admin).filter((tool) => tool.action === 'widget.activate');
    expect(tools.map((tool) => tool.name)).toEqual(['admin.action.widget.activate']);
    expect(tools[0]?.input.map((field) => field.name)).toEqual(['id', 'ids']);
    const refused = await callAdminTool(admin, ctx(), 'admin.action.widget.activate', {
      id: ids.active,
    });
    expect(refused).toMatchObject({ ok: false, error: 'X_ADMIN_ACTION_NOT_APPLICABLE' });
  });

  test('a row it applies to runs, and lands on the row', async () => {
    const fresh = String((await db.widgets.insert({ title: 'Fresh one' })).id);
    const answer = await ask(`${BASE}/${fresh}`, { _operation: 'action', name: 'widget.activate' });
    expect(status(answer)).toBe(`${BASE}/${fresh}`);
    expect(ran).toContain(`activate:${fresh}`);
    // …and now that it is active, the same post is refused: the rule reads the row as it is NOW.
    const again = await ask(`${BASE}/${fresh}`, { _operation: 'action', name: 'widget.activate' });
    expect(status(again)).toBe(409);
  });
});

describe('unit · an action with an input schema is a form; one without is a confirm', () => {
  test('the button of an action with input is a LINK to its form, at the row’s URL', async () => {
    const detail = await ask(`${BASE}/${ids.idle}`);
    expect(detail.html).toContain(`href="${BASE}/${ids.idle}?action=widget.rename"`);
    // No schema: a native post of the action's name, no fields.
    expect(detail.html).toContain('value="widget.activate"');
  });

  test('the form draws one control per property, labelled through t()', async () => {
    const form = await ask(`${BASE}/${ids.idle}?action=widget.rename`);
    expect(status(form)).toBe(200);
    expect(form.html).toContain('NEW-TITLE-LABEL');
    expect(form.html).toContain('name="input.title"');
    expect(form.html).toContain('name="input.loud"');
    expect(form.html).toContain(`action="${BASE}/${ids.idle}"`);
  });

  test('a refusal comes back 422 with the issue against its field and what was typed', async () => {
    const before = ran.length;
    const refused = await ask(`${BASE}/${ids.idle}`, {
      _operation: 'action',
      name: 'widget.rename',
      'input.title': 'ab',
    });
    expect(status(refused)).toBe(422);
    expect(refused.html).toContain('value="ab"');
    expect(refused.html).toContain('at least 3');
    expect(ran.length).toBe(before);
  });

  test('a valid post runs the handler with the parsed input and the row id', async () => {
    const answer = await ask(`${BASE}/${ids.idle}`, {
      _operation: 'action',
      name: 'widget.rename',
      'input.title': 'Renamed',
      'input.loud': 'on',
    });
    expect(status(answer)).toBe(`${BASE}/${ids.idle}`);
    expect(ran).toContain(`rename:${ids.idle}:Renamed:true`);
  });

  test('the form of an action that does not apply to the row is the row’s 404', async () => {
    expect(status(await ask(`${BASE}/${ids.active}?action=widget.activate`))).toBe(404);
    expect(status(await ask(`${BASE}/${ids.idle}?action=widget.nope`))).toBe(404);
  });
});

describe('unit · an action with input fits one nested JSON catalog', () => {
  test("no field's label key nests under the action's own label key", async () => {
    const { actionInputFields } = await import('./action-input');
    const { flattenCatalog, parseNestedCatalog } = await import('@ultimat3/i18n');
    const rename = { name: 'widget.rename', input: t.object({ title: t.string, loud: t.boolean }) };
    const label = `admin.action.${rename.name}`;
    const keys = [label, ...actionInputFields(rename).map((field) => field.labelKey)];
    // A JSON catalog is a tree: a key that is a leaf cannot also be a branch.
    for (const key of keys) {
      expect(keys.some((other) => other !== key && other.startsWith(`${key}.`))).toBe(false);
    }
    // And the app's catalog file that holds all three parses and flattens back to them.
    const nested: Record<string, unknown> = {};
    for (const key of keys) {
      const parts = key.split('.');
      let at = nested;
      for (const part of parts.slice(0, -1)) {
        at[part] ??= {};
        at = at[part] as Record<string, unknown>;
      }
      at[parts.at(-1) ?? ''] = key;
    }
    expect(Object.keys(flattenCatalog(parseNestedCatalog(nested))).sort()).toEqual(
      [...keys].sort(),
    );
  });
});
