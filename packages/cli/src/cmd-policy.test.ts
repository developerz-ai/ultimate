// `x policy list|explain` against real registrations — same reasoning `cmd-registries.test.ts`
// gives for actions/queries/entities: a fixture that only pretended to declare a permission would
// prove nothing about whether the command reads the app's own policy objects. Registries are
// process-global, so every test resets them.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete and no path API: `rm` tears down the two fixture app roots
// this suite writes, and `join` is what builds their paths in the first place.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { action, registerActions, resetRegistry as resetActions, t } from '@ultimat3/action';
import type { Policy } from '@ultimat3/policy';
import { can, clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { policyCommand } from './cmd-policy';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { FlagValue } from './parse';
import { parseArgs } from './parse';
import { registerPolicyFixture } from './policy-fixture';
import type { ThrownShape } from './thrown-by';

const ROOT = join(import.meta.dir, '..', '.policy-fixture');
const BROKEN = join(import.meta.dir, '..', '.policy-broken-fixture');
const APP_CONFIG = `export const config = { name: 'fixture' };\n`;

const contextFor = (
  subcommand: string | undefined,
  positionals: readonly string[] = [],
  cwd: string = ROOT,
): CommandContext => ({
  args: {
    command: 'policy',
    subcommand,
    positionals,
    flags: new Map<string, FlagValue>(),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: {},
  bunVersion: '1.3.0',
});

/** The thrown value, so a test can assert on `code`/`fix` — `run()` rejects, it never returns an
 * `ok: false` result for a bad flag or an unknown declaration. */
async function rejectedBy(call: () => Promise<unknown>): Promise<ThrownShape> {
  try {
    await call();
  } catch (error) {
    return error as ThrownShape;
  }
  return expect.unreachable('expected a rejection');
}

beforeAll(async () => {
  await Bun.write(join(ROOT, 'app.config.ts'), APP_CONFIG);
  await Bun.write(join(BROKEN, 'app.config.ts'), APP_CONFIG);
  await Bun.write(
    join(BROKEN, 'apps/web/app/broken.ts'),
    `export { nope } from './does-not-exist';\n`,
  );
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(BROKEN, { recursive: true, force: true });
});

/**
 * Reset BEFORE registering, not only after. The declaration registries are process-global and
 * `bun test` runs every file in one process, so whatever ran first — the reference app registers
 * its own `publishPost` — is still seated when the first `registerPolicyFixture()` lands and the
 * name collides with `X_ACTION_DUPLICATE`. Clearing first is what makes this file
 * order-independent instead of passing alone and failing in the full suite.
 */
beforeEach(() => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
  registerPolicyFixture();
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
});

describe('unit · x policy · spec', () => {
  test('names both subcommands, list first, requires an app', () => {
    expect(policyCommand.spec.name).toBe('policy');
    expect(policyCommand.spec.subcommands).toEqual(['list', 'explain']);
    expect(policyCommand.spec.requiresApp).toBe(true);
    expect(policyCommand.spec.summary).toBe('which clause decided a permission, and why');
    expect(policyCommand.spec.usage).toBe('x policy [list|explain <subject>] [--json]');
  });

  test('the default subcommand is list — for the parser, and for run() given no subcommand', async () => {
    const parsed = parseArgs(['policy'], [policyCommand.spec]);
    expect(parsed.subcommand).toBe('list');

    const viaParser = await policyCommand.run(contextFor(parsed.subcommand, parsed.positionals));
    const viaUndefined = await policyCommand.run(contextFor(undefined));
    expect(viaParser.summary).toBe(viaUndefined.summary);
  });
});

describe('unit · x policy list', () => {
  test('a row per permission — roles, actions and queries joined, "-" when none', async () => {
    const result = await policyCommand.run(contextFor('list'));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.policy.count', { permissions: 4, roles: 3, enforced: 3 }));
    expect(result.lines?.[0]).toContain('permission');

    const publishLine = result.lines?.find((line) => line.trim().startsWith('post:publish'));
    expect(publishLine).toContain('publishPost');
    expect(publishLine).toContain('publishedPosts');

    const readLine = result.lines?.find((line) => line.trim().startsWith('post:read'));
    expect(readLine).toBeDefined();
    expect(readLine).not.toContain('publishPost');
    // The composite's second permission, which used to render as enforced by nothing.
    expect(readLine).toContain('archivePost');

    expect(result.data).toEqual([
      { permission: 'feed:read', roles: ['admin', 'reader'], actions: [], queries: ['postFeed'] },
      { permission: 'post:delete', roles: ['admin'], actions: [], queries: [] },
      {
        permission: 'post:publish',
        roles: ['admin', 'editor'],
        actions: ['archivePost', 'publishPost'],
        queries: ['publishedPosts'],
      },
      {
        permission: 'post:read',
        roles: ['admin', 'editor', 'reader'],
        actions: ['archivePost'],
        queries: [],
      },
    ]);
  });

  test('an unenforced permission gets its own summary line and the very next line names it', async () => {
    const result = await policyCommand.run(contextFor('list'));
    const lines = result.lines ?? [];
    const at = lines.findIndex((line) => line.includes(msg('cli.policy.unenforced', { count: 1 })));
    expect(at).toBeGreaterThanOrEqual(0);
    // `post:delete` and not `post:read`: the composite enforces `post:read`, so the only grant
    // left doing nothing is the one no declaration references at all.
    expect(lines[at + 1]?.trim()).toBe('post:delete');
  });
});

describe('unit · x policy explain', () => {
  test('a permission aggregates every enforcing declaration into one summary and one table each', async () => {
    const result = await policyCommand.run(contextFor('explain', ['post:publish']));
    expect(result.ok).toBe(true);
    // THREE declarations × four actors: twelve evaluations, not twelve roles — the app declares
    // three. The third is `archivePost`, whose composite references this permission; matching on
    // the display label left it out and under-reported the blast radius of the grant.
    expect(result.summary).toBe(
      msg('cli.policy.explained', { subject: 'post:publish', allowed: 5, evaluations: 12 }),
    );
    const rendered = (result.lines ?? []).join('\n');
    expect(rendered).toContain(
      msg('cli.policy.declaration', {
        kind: 'action',
        name: 'publishPost',
        label: 'post:publish',
      }),
    );
    expect(rendered).toContain(
      msg('cli.policy.declaration', {
        kind: 'query',
        name: 'publishedPosts',
        label: 'post:publish',
      }),
    );
    // Every rendered table says what it was evaluated without.
    expect(rendered).toContain(msg('cli.policy.noInput'));

    const data = result.data as {
      kind: string;
      grantingRoles: readonly string[];
      declarations: readonly unknown[];
    };
    expect(data.kind).toBe('permission');
    expect(data.grantingRoles).toEqual(['admin', 'editor']);
    expect(data.declarations).toHaveLength(3);
  });

  test('a compound policy names the SPECIFIC deciding clause per actor, not the and() wrapper', async () => {
    const result = await policyCommand.run(contextFor('explain', ['archivePost']));
    expect(result.ok).toBe(true);
    const rendered = (result.lines ?? []).join('\n');
    expect(rendered).toContain(
      msg('cli.policy.declaration', {
        kind: 'action',
        name: 'archivePost',
        label: 'and(post:publish, post:read)',
      }),
    );

    const editorLine = result.lines?.find((line) => line.trim().startsWith('editor'));
    expect(editorLine).toContain(msg('cli.policy.deny'));
    expect(editorLine).toContain('post:read');

    const readerLine = result.lines?.find((line) => line.trim().startsWith('reader'));
    expect(readerLine).toContain(msg('cli.policy.deny'));
    expect(readerLine).toContain('post:publish');
  });

  test('resolves an action by its HTTP path', async () => {
    const result = await policyCommand.run(contextFor('explain', ['/api/posts/publish']));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.policy.explained', { subject: '/api/posts/publish', allowed: 2, evaluations: 4 }),
    );
    expect((result.data as { kind: string }).kind).toBe('action');
  });

  test('resolves a query by name', async () => {
    const result = await policyCommand.run(contextFor('explain', ['postFeed']));
    expect(result.summary).toBe(
      msg('cli.policy.explained', { subject: 'postFeed', allowed: 2, evaluations: 4 }),
    );
    expect((result.data as { kind: string }).kind).toBe('query');
  });

  test('a policy that dereferences request input renders the note instead of crashing', async () => {
    // Registered on top of the fixture, so only this subject is undecidable: `input.post` is
    // undefined outside a request and the predicate throws where the matrix used to run.
    interface PostInput {
      readonly post: { readonly id: string };
    }
    const policy: Policy<PostInput> = can<PostInput>(
      'post:publish',
      ({ input }) => input.post.id === 'post_1',
    );
    registerActions({
      restorePost: action({
        input: t.object({}),
        output: t.object({}),
        policy,
        async handle() {
          return {};
        },
      }),
    });

    const result = await policyCommand.run(contextFor('explain', ['restorePost']));
    expect(result.ok).toBe(true);
    const rendered = (result.lines ?? []).join('\n');
    expect(rendered).toContain(msg('cli.policy.undecidable'));
    expect(rendered).not.toContain('anonymous');
    expect(rendered).not.toContain(msg('cli.policy.noInput'));
    expect(result.summary).toBe(
      msg('cli.policy.explained', { subject: 'restorePost', allowed: 0, evaluations: 0 }),
    );
    expect(
      (result.data as { declarations: readonly { decidable: boolean }[] }).declarations,
    ).toEqual([expect.objectContaining({ decidable: false, rows: [] })]);
  });
});

describe('unit · x policy errors', () => {
  // The CODE is the same either way, so it proves nothing on its own: what a `BadFlagError` here
  // produced was `--subject on "x policy"`, and `x policy explain --subject posts:read` is then a
  // second X_CLI_BAD_FLAG for a flag this command does not declare. The cause is the assertion.
  test('explain with no positional names the POSITIONAL, never a flag', async () => {
    const thrown = await rejectedBy(() => policyCommand.run(contextFor('explain', [])));
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(thrown.cause).toBe('"x policy explain" needs a <subject> positional and got none');
    expect(thrown.cause).not.toContain('--');
    expect(thrown.fix).toBe('x policy list --json');
  });

  test('explain <typo> suggests the nearest known subject', async () => {
    const thrown = await rejectedBy(() => policyCommand.run(contextFor('explain', ['archivPost'])));
    expect(thrown).toBeUltimateError('X_DECLARATION_UNKNOWN');
    expect(thrown.cause).toContain('archivPost');
    expect(thrown.fix).toBe('x policy explain archivePost');
  });

  test('explain <unrelated> falls back to list --json when nothing is close enough to suggest', async () => {
    const thrown = await rejectedBy(() =>
      policyCommand.run(contextFor('explain', ['completely-unrelated-name'])),
    );
    expect(thrown).toBeUltimateError('X_DECLARATION_UNKNOWN');
    expect(thrown.fix).toBe('x policy list --json');
  });
});

describe('unit · x policy findings', () => {
  test('a module that will not import is a finding, and ok is false', async () => {
    const result = await policyCommand.run(contextFor('list', [], BROKEN));
    expect(result.ok).toBe(false);
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(result.findings?.[0]?.at).toBe('apps/web/app/broken.ts');
  });
});
