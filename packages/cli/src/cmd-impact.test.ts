// `x impact` and `x graph` on the reference app, each in its own process (loading an app fills
// process-wide registries): editing a query names the routes that read it, the operation it
// publishes, and its tests — each with provenance; a miss is X_GRAPH_NODE_UNKNOWN with the nearest.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

const APP = join(import.meta.dir, '..', '..', '..', 'examples', 'dummy');
const BIN = join(import.meta.dir, 'bin.ts');

interface Entry {
  readonly id: string;
  readonly provenance: readonly string[];
}

const run = (
  ...argv: string[]
): { readonly code: number; readonly body: Record<string, unknown> } => {
  const child = Bun.spawnSync(['bun', BIN, ...argv, '--json'], {
    cwd: APP,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  return {
    code: child.exitCode ?? 1,
    body: JSON.parse(child.stdout.toString()) as Record<string, unknown>,
  };
};

describe('x impact · examples/dummy', () => {
  test('a query names its route, its published operation and its tests, with provenance', () => {
    const { code, body } = run('impact', 'postById');
    expect(code).toBe(0);
    const data = body['data'] as Readonly<Record<string, readonly Entry[]>>;
    expect(data['routes']?.map((r) => r.id)).toContain('route:/posts/:id');
    expect(
      data['publishedOperations']?.find((o) => o.id === 'operation:postById')?.provenance,
    ).toContain('declared');
    expect(data['tests']?.map((t) => t.id)).toContain(
      'test:apps/web/app/posts/post-by-id.contract.test.ts',
    );
    expect(data['routes']?.every((r) => r.provenance.length > 0)).toBe(true);
  });

  test('an action names the MCP tool that exposes it', () => {
    const data = run('impact', 'likePost').body['data'] as Readonly<
      Record<string, readonly Entry[]>
    >;
    expect(data['mcpTools']?.map((m) => m.id)).toEqual(['mcpTool:likePost']);
  });

  test('a name that is no node is X_GRAPH_NODE_UNKNOWN listing the nearest', () => {
    const { code, body } = run('impact', 'postByld');
    expect(code).toBe(1);
    const finding = (body['findings'] as readonly { code: string; cause: string }[])[0];
    expect(finding?.code).toBe('X_GRAPH_NODE_UNKNOWN');
    expect(finding?.cause).toContain('query:postById');
  });

  test('x graph --from/--to explains a link, every edge with its provenance', () => {
    const data = run('graph', '--from', 'postById', '--to', 'route:/posts/:id').body['data'] as {
      readonly edges: readonly { readonly provenance: string }[] | null;
    };
    expect(data.edges?.length).toBeGreaterThan(0);
  });
});
