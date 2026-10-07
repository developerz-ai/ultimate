import { describe, expect, test } from 'bun:test';
import { allow } from '@ultimat3/policy';
import { t as schemaT } from '@ultimat3/schema';
import * as surface from './index';
import { t } from './index';

describe('@ultimat3/query public surface', () => {
  test('a page is asked for through the query, so `paginate` is not on the barrel', () => {
    // Re-exporting it would be a second way to do what `.page()` already does, and the omission
    // is the only thing enforcing that — nothing else fails when the export comes back.
    expect(Object.keys(surface)).not.toContain('paginate');
    expect(surface).not.toHaveProperty('paginate');
  });

  test('no tool-name deriver on the barrel — a read has ONE name, its export name', () => {
    // `@ultimat3/mcp` serves a read under `queryName(target)` and answers `tools/call` for
    // nothing else, so any second spelling names a tool the server has never heard of. That
    // package is tier 4 and cannot be imported here to prove it, which is exactly why the pin
    // has to live in the package where the deriver can be reintroduced.
    // `mcp-tool.test.ts` pins the descriptor's name structurally; this pins the ABSENCE.
    expect(surface).not.toHaveProperty('toToolName');
    const derivers = Object.keys(surface).filter((key) => /tool_?name/i.test(key));
    expect(derivers).toEqual([]);
  });

  test('the deprecation helpers are core’s alone — 25.0.0 dropped the re-exports', () => {
    // `@ultimat3/core` is their one home (`HELPER_HOMES`); a re-export here is a second import
    // path to the same function, which is how an app ends up with two spellings in one file.
    for (const name of ['renderDeprecation', 'recordDeprecatedCall']) {
      expect(surface).not.toHaveProperty(name);
    }
  });

  // 25.0.0, one name one meaning (`scripts/factory-names.ts`): each of these was a second
  // declaration of a name `@ultimat3/action`, `@ultimat3/policy` or `@ultimat3/core` also declares.
  test('no twin of a sibling or lower-tier name — each renamed or imported from its one home', () => {
    for (const name of [
      'Builder',
      'actorOf',
      'derivePath',
      'explain',
      'guard',
      'guardBeforeInput',
      'policyCapability',
      'resetRegistry',
    ]) {
      expect(surface).not.toHaveProperty(name);
    }
    for (const name of ['explainQuery', 'guardQuery', 'guardQueryBeforeInput', 'resetQueries']) {
      expect(typeof Reflect.get(surface, name)).toBe('function');
    }
  });

  // O-tool, 25.0.0: an MCP tool has ONE projection, `@ultimat3/mcp`'s `toolFrom` — the one
  // `tools/list` serves. `.tool()` was a second one built here; tier 3 cannot import the tier-4
  // projection, so the twin could not be made to return it. It is gone, and this keeps it gone.
  test('no MCP tool projection lives here — `@ultimat3/mcp` owns the one', () => {
    for (const name of ['toQueryTool', 'toQueryTools', 'isExposed']) {
      expect(surface).not.toHaveProperty(name);
    }
    const read = surface
      .query({
        input: schemaT.object({}),
        policy: allow('public'),
        mcp: { expose: true },
        sql: () => surface.from<{ id: string }>('posts', []),
      })
      .named('postList');
    expect(read).not.toHaveProperty('tool');
  });

  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working schema', () => {
    const schema = t.object({ limit: t.number.max(50) });
    expect(schema.parse({ limit: 50 })).toEqual({ limit: 50 });
    expect(() => schema.parse({ limit: 51 })).toThrow();
  });

  // 25.0.0: a value whose home is a lower tier is imported from that tier, never re-published here
  // — `admitsAnonymous`/`policyPermissions` are `@ultimat3/policy`'s, `MAX_PAGE_SIZE` is
  // `@ultimat3/entity`'s. Core's values are `bun run flight-copies`' (`X_HELPER_COPY`); these are not
  // core's, so the absence is pinned where the export could come back.
  test('no value of a lower-tier package is re-published on the barrel', () => {
    for (const name of ['admitsAnonymous', 'policyPermissions', 'MAX_PAGE_SIZE']) {
      expect(surface).not.toHaveProperty(name);
    }
  });
});
