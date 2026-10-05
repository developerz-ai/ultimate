// `renderCatalog` / `oneLineParams`: the three rules that keep `list_resources` small (#590) without
// dropping a fact a call needs — a shared scope said once, only `action` tagged, hints cut by field
// with every required one named. Each case below is one an agent would otherwise call wrongly.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { MetaAction, MetaResource } from './meta-surface';
import { oneLineParams, renderCatalog } from './meta-surface';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';
import { createMcpServer } from './server';
import type { JsonSchema } from './wire';
import { NO_ARGS } from './wire';

const act = (name: string, more: Partial<MetaAction> = {}): MetaAction => ({
  name,
  kind: 'query',
  description: `The ${name} tool.`,
  params: '',
  ...more,
});
const resource = (name: string, actions: readonly MetaAction[]): MetaResource => ({
  name,
  description: `All about ${name}.`,
  actions,
});
/** The catalog minus its header line, which says what the tags mean once. */
const body = (resources: readonly MetaResource[]): readonly string[] =>
  renderCatalog(resources).split('\n').slice(1);

describe('renderCatalog — scope hoisting', () => {
  test('a scope every action carries is said once, on the resource line', () => {
    expect(
      body([
        resource('cases', [
          act('archiveCase', {
            kind: 'action',
            confirms: true,
            scope: 'cases',
            params: 'id: string',
          }),
          act('listCases', { scope: 'cases', params: 'status?: "open"|"closed", …' }),
        ]),
      ]),
    ).toEqual([
      '',
      'cases (scope cases) — All about cases.',
      '  archiveCase (action; confirms) {id: string} — The archiveCase tool.',
      '  listCases {status?: "open"|"closed", …} — The listCases tool.',
    ]);
  });

  test('a read/write split hoists per kind', () => {
    expect(
      body([
        resource('invoices', [
          act('getInvoice', { scope: 'invoices:read' }),
          act('voidInvoice', { kind: 'action', scope: 'invoices:write' }),
          act('listInvoices', { scope: 'invoices:read' }),
        ]),
      ]),
    ).toEqual([
      '',
      'invoices (query scope invoices:read; action scope invoices:write) — All about invoices.',
      '  getInvoice {} — The getInvoice tool.',
      '  voidInvoice (action) {} — The voidInvoice tool.',
      '  listInvoices {} — The listInvoices tool.',
    ]);
  });

  test('scopes that differ within a kind stay on each action, and the kind that agrees is hoisted', () => {
    expect(
      body([
        resource('users', [
          act('listUsers', { scope: 'users:read' }),
          act('inviteUser', { kind: 'action', scope: 'users:invite' }),
          act('dropUser', { kind: 'action', scope: 'users:admin' }),
        ]),
      ]),
    ).toEqual([
      '',
      'users (query scope users:read) — All about users.',
      '  listUsers {} — The listUsers tool.',
      '  inviteUser (action; scope users:invite) {} — The inviteUser tool.',
      '  dropUser (action; scope users:admin) {} — The dropUser tool.',
    ]);
  });

  test('one unscoped action stops the hoist: it must not inherit a gate it does not have', () => {
    expect(
      body([resource('docs', [act('readDoc', { scope: 'docs' }), act('searchDocs')])]),
    ).toEqual([
      '',
      'docs — All about docs.',
      '  readDoc (scope docs) {} — The readDoc tool.',
      '  searchDocs {} — The searchDocs tool.',
    ]);
  });

  test('a resource with no scope at all says none', () => {
    expect(body([resource('misc', [act('ping')])])).toEqual([
      '',
      'misc — All about misc.',
      '  ping {} — The ping tool.',
    ]);
  });
});

describe('renderCatalog — kind', () => {
  test('the tag follows the kind, never the name', () => {
    const lines = body([
      resource('odd', [
        act('deleteNothing'),
        act('listAndArchive', { kind: 'action' }),
        act('peek', { confirms: true }),
      ]),
    ]);
    expect(lines).toContain('  deleteNothing {} — The deleteNothing tool.');
    expect(lines).toContain('  listAndArchive (action) {} — The listAndArchive tool.');
    expect(lines).toContain('  peek (confirms) {} — The peek tool.');
  });

  test('the header says what an untagged action is, so the default is not a guess', () => {
    const header = renderCatalog([resource('misc', [act('ping')])]).split('\n')[0];
    expect(header).toInclude('Untagged = read-only query');
    expect(header).toInclude('(confirms) waits for a human');
    expect(header).toInclude('… = more in describe_resource');
  });
});

const props = (names: readonly string[], type: JsonSchema = { type: 'string' }) =>
  Object.fromEntries(names.map((name) => [name, type]));

describe('oneLineParams — cut by field, never by character', () => {
  test('optional fields stop at four, and the cut is marked', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: props(['a', 'b', 'c', 'd', 'e', 'f']),
    };
    expect(oneLineParams(schema)).toBe('a?: string, b?: string, c?: string, d?: string, …');
  });

  test('every required field is named, past four and after optional ones, in declared order', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: props(['note', 'a', 'b', 'c', 'd', 'e', 'last']),
      required: ['a', 'b', 'c', 'd', 'e', 'last'],
    };
    expect(oneLineParams(schema)).toBe(
      'a: string, b: string, c: string, d: string, e: string, last: string, …',
    );
  });

  test('required fields count toward the four; optional ones fill what is left', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: props(['id', 'x', 'y', 'z', 'w']),
      required: ['id'],
    };
    expect(oneLineParams(schema)).toBe('id: string, x?: string, y?: string, z?: string, …');
  });

  test('a hint that names every field carries no marker', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' }, limit: { type: 'integer' } },
      required: ['id'],
    };
    expect(oneLineParams(schema)).toBe('id: string, limit?: integer');
  });

  test('long optional fields stop early by length, whole, never sliced', () => {
    const wide: JsonSchema = { type: 'string', enum: ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'] };
    const schema: JsonSchema = {
      type: 'object',
      properties: { ...props(['first', 'second', 'third'], wide), id: { type: 'string' } },
      required: ['id'],
    };
    const hint = oneLineParams(schema);
    expect(hint).toBe('first?: "aaaaaaaaaa"|"bbbbbbbbbb"|"cccccccccc", id: string, …');
  });

  test('an enum of many literals is cut at a literal, with the cut marked', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { day: { type: 'integer', enum: Array.from({ length: 31 }, (_, i) => i + 1) } },
      required: ['day'],
    };
    expect(oneLineParams(schema)).toBe('day: 1|2|3|4|5|6|7|8|…');
  });

  test('no params is an empty hint', () => {
    expect(oneLineParams({ type: 'object', properties: {} })).toBe('');
  });
});

describe('list_resources — a raw tool that never said', () => {
  test('a raw tool with no destructive flag is tagged (action): untagged means a DECLARED read', () => {
    const raw: AnyMcpTool = {
      name: 'raw',
      description: 'Raw.',
      inputSchema: NO_ARGS,
      handle: async () => textResult('ok'),
    };
    const server = createMcpServer({
      tools: [raw, { ...raw, name: 'read', destructive: false }],
      surface: 'meta',
      groups: { things: { description: 'Things', tools: ['raw', 'read'] } },
    });
    const caller: McpCaller = { actor: agentActor({ id: 'a1' }), scopes: new Set<string>() };
    expect(body(server.catalog(caller) ?? [])).toEqual([
      '',
      'things — Things',
      '  raw (action) {} — Raw.',
      '  read {} — Raw.',
    ]);
  });
});
