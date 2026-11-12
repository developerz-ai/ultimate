// A projected list query answers ONE bounded page: at most `MAX_WIRE_PAGE_SIZE` rows and
// `QUERY_LIMITS.maxBytes` of JSON, `truncated` when either bit, and a `nextCursor` the agent hands
// back as `_after`. An answer that fits is the bare rows it always was.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, MAX_WIRE_PAGE_SIZE, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import { toolFrom } from './from-action';
import { QUERY_LIMITS } from './query-limits';
import { MCP_QUERY_AFTER_ARG } from './query-page';
import type { McpCaller, McpToolResult } from './registry';

const caller: McpCaller = {
  actor: agentActor({ id: 'a1', orgId: 'o1', roles: ['reader'] }),
  scopes: new Set<string>(),
};
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

interface Post {
  readonly id: string;
  readonly body: string;
}
const posts = (count: number, body = 'x'): Post[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${String(i).padStart(5, '0')}`, body }));

const listed = (name: string, rows: readonly Post[], declared = true) =>
  registerQuery(
    name,
    query({
      input: t.object({}),
      policy: can('post:read'),
      mcp: { expose: true, description: 'posts' },
      ...(declared ? { rows: t.object({ id: t.string, body: t.string }) } : {}),
      sql: () => from<Post>('posts', [...rows]),
    }),
  );

const structured = (result: McpToolResult) =>
  (result.structuredContent ?? {}) as {
    rows?: Post[];
    truncated?: boolean;
    truncatedBy?: string;
    nextCursor?: string;
  };

const textBlocks = (result: McpToolResult): string[] =>
  result.content.map((block) => (block.type === 'text' ? block.text : ''));

beforeEach(() => {
  definePermissions(['post:read']);
  defineRoles({ reader: { grants: ['post:read'] } });
});
afterEach(() => {
  resetQueries();
  clearPermissions();
  clearRoles();
});

describe('a projected list query never returns an unbounded result', () => {
  test('5,000 rows answer one capped page, truncated, with a cursor that continues it', async () => {
    const tool = toolFrom(listed('feed', posts(5_000)));
    const first = await inRequest(() => tool.handle({}, caller));
    const page = structured(first);
    expect(page.rows).toHaveLength(MAX_WIRE_PAGE_SIZE);
    expect(page.truncated).toBe(true);
    expect(page.truncatedBy).toBe('rows');
    expect(typeof page.nextCursor).toBe('string');

    const second = await inRequest(() =>
      tool.handle({ [MCP_QUERY_AFTER_ARG]: page.nextCursor }, caller),
    );
    const next = structured(second).rows ?? [];
    expect(next[0]?.id).toBe(`p${String(MAX_WIRE_PAGE_SIZE).padStart(5, '0')}`);
  });

  test('rows past the byte ceiling are cut, and the cursor resumes at the first row cut', async () => {
    const body = 'y'.repeat(4_000);
    const tool = toolFrom(listed('fat', posts(200, body)));
    const page = structured(await inRequest(() => tool.handle({}, caller)));
    const kept = page.rows ?? [];
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(QUERY_LIMITS.maxBytes);
    expect(kept.length).toBeGreaterThan(0);
    expect(page.truncatedBy).toBe('bytes');
    const resumed = structured(
      await inRequest(() => tool.handle({ [MCP_QUERY_AFTER_ARG]: page.nextCursor }, caller)),
    );
    expect(resumed.rows?.[0]?.id).toBe(`p${String(kept.length).padStart(5, '0')}`);
  });

  test('an answer that fits is the bare rows it always was — no page keys, one text block', async () => {
    const result = await inRequest(() => toolFrom(listed('small', posts(3))).handle({}, caller));
    expect(Object.keys(structured(result))).toEqual(['rows']);
    expect(textBlocks(result)).toHaveLength(1);
  });

  test('without a row schema the text answer says it was truncated, in a second block', async () => {
    const result = await inRequest(() =>
      toolFrom(listed('plain', posts(MAX_WIRE_PAGE_SIZE + 1), false)).handle({}, caller),
    );
    const [rows, page] = textBlocks(result);
    expect((JSON.parse(rows ?? '[]') as unknown[]).length).toBe(MAX_WIRE_PAGE_SIZE);
    expect(JSON.parse(page ?? '{}')).toMatchObject({ truncated: true, truncatedBy: 'rows' });
  });

  test('the cursor argument is advertised on a list read', () => {
    const tool = toolFrom(listed('advertised', posts(1)));
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(MCP_QUERY_AFTER_ARG);
  });

  test('a read whose rows carry no id is still served, capped, with no cursor to offer', async () => {
    const rows = Array.from({ length: MAX_WIRE_PAGE_SIZE + 10 }, (_, i) => ({ label: `l${i}` }));
    const tool = toolFrom(
      registerQuery(
        'labels',
        query({
          input: t.object({}),
          policy: can('post:read'),
          mcp: { expose: true, description: 'labels' },
          sql: () => from<{ label: string }>('labels', rows),
        }),
      ),
    );
    const [text, page] = textBlocks(await inRequest(() => tool.handle({}, caller)));
    expect((JSON.parse(text ?? '[]') as unknown[]).length).toBe(MAX_WIRE_PAGE_SIZE);
    expect(JSON.parse(page ?? '{}')).toEqual({ truncated: true, truncatedBy: 'rows' });
  });
});
