// A scaffolded file that names an `x` command this build does not ship is broken, not merely long:
// the agent reading it runs the line and gets "no such command". Same failure `cmd-planned.test.ts`
// closes for the planned table, applied to the prose `x new` writes — every `x …` in it, `.claude/`
// and the docs beside it alike, must resolve to a shipped command and a real subcommand.

import { describe, expect, test } from 'bun:test';
import { SPECS } from '../registry';
import { names } from './naming';
import { claudeFiles } from './scaffold-claude';
import { docsFiles } from './scaffold-docs';

const app = names('ledger-demo');

/** A planned command exits X_NOT_IMPLEMENTED, so citing one is the same dead end as a typo. */
const SHIPPED = new Map(
  SPECS.filter((spec) => !spec.summary.endsWith('(planned)')).map((spec) => [
    spec.name,
    new Set(spec.subcommands ?? []),
  ]),
);

interface Citation {
  readonly command: string;
  /** The next word, when it is a bare one — `--json` and `<name>` are not subcommands. */
  readonly subcommand: string | undefined;
}

/**
 * `x` or `bunx x`, never a word ending in x and never `x.manifest.json`. A colon is part of a name
 * only between two words (`admin:page`) — a trailing one is the `:*` of a permission rule.
 */
const WORD = '[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?';
const INVOCATION = new RegExp(
  String.raw`(?:^|[^\w.\-/])(?:bunx\s+)?x\s+(${WORD})(\s+${WORD})?`,
  'g',
);

export const citationsIn = (text: string): readonly Citation[] =>
  [...text.matchAll(INVOCATION)].map((match) => ({
    command: match[1] ?? '',
    subcommand: match[2]?.trim(),
  }));

const unknown = (text: string): readonly string[] =>
  citationsIn(text).flatMap((cite) => {
    const subs = SHIPPED.get(cite.command);
    if (subs === undefined) return [`x ${cite.command}`];
    if (cite.subcommand !== undefined && subs.size > 0 && !subs.has(cite.subcommand))
      return [`x ${cite.command} ${cite.subcommand}`];
    return [];
  });

const textOf = (files: readonly { readonly contents: string | Uint8Array }[]): string =>
  files.map((file) => (typeof file.contents === 'string' ? file.contents : '')).join('\n');

describe('unit · the .claude bundle names only shipped commands', () => {
  test('the check itself fails on a command that does not ship', () => {
    // Without this the whole suite could be a green regex that matches nothing. `x lint` never
    // existed; `x cache bust` is in the registry but planned, and a planned command is not a fix.
    expect(unknown('run `x lint` first')).toEqual(['x lint']);
    expect(unknown('run `x cache bust orders`')).toEqual(['x cache']);
    expect(unknown('run `x db squash`')).toEqual(['x db squash']);
  });

  test('and it does resolve the commands that do ship, subcommand included', () => {
    expect(unknown('`x verify --json`, `x db migrate`, `x g resource post`')).toEqual([]);
    // Prose that merely contains an x must not be read as an invocation.
    expect(unknown('x.manifest.json and apps/web/prerender.ts')).toEqual([]);
  });

  test('every `x …` the .claude bundle writes is a shipped command', () => {
    expect(unknown(textOf(claudeFiles(app)))).toEqual([]);
  });

  test('every `x …` in the rest of what x new writes is too', () => {
    // The bundle is not a special case: AGENTS.md, CLAUDE.md, the READMEs, `bin/` and the deploy
    // page are read by the same agent and break the same way.
    expect(unknown(textOf(docsFiles(app)))).toEqual([]);
  });
});

describe('unit · the .claude bundle stays deletable and self-contained', () => {
  test('every file lands under .claude/ in the app, and nothing outside the project', () => {
    for (const file of claudeFiles(app)) {
      expect(file.path.startsWith('.claude/')).toBe(true);
      expect(file.path).not.toContain('..');
      expect(file.path).not.toContain('~');
    }
  });

  test('settings.json parses, and allows nothing destructive', () => {
    const settings = claudeFiles(app).find((file) => file.path === '.claude/settings.json');
    const parsed: unknown = JSON.parse(String(settings?.contents ?? ''));
    const allow = (parsed as { permissions: { allow: readonly string[] } }).permissions.allow;
    expect(allow.length).toBeGreaterThan(0);
    // Each of these either drops data, writes production or decrypts secrets. An allowlist that
    // pre-approves one turns the permission prompt into the thing nobody reads.
    for (const forbidden of ['db reset', 'backfill', 'secrets', 'deploy', 'git push', 'git commit'])
      expect(allow.some((rule) => rule.includes(forbidden))).toBe(false);
  });

  test('exactly one PostToolUse hook, and it names a binary the scaffold installs', () => {
    const settings = claudeFiles(app).find((file) => file.path === '.claude/settings.json');
    const parsed = JSON.parse(String(settings?.contents ?? '')) as {
      hooks: { PostToolUse: readonly { hooks: readonly { command: string }[] }[] };
    };
    const hooks = parsed.hooks.PostToolUse.flatMap((entry) => entry.hooks);
    expect(hooks).toHaveLength(1);
    // biome is a devDependency `x new` writes into the root package.json; `x verify --only` is not
    // a flag and never will be, so a per-step gate hook is not an option here.
    expect(hooks[0]?.command).toContain('biome');
  });

  test('every subagent declares a name and a description, or it is never dispatched', () => {
    const agents = claudeFiles(app).filter((file) => file.path.startsWith('.claude/agents/'));
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      const source = String(agent.contents);
      expect(source.startsWith('---\n')).toBe(true);
      expect(source).toContain('\nname: ');
      expect(source).toContain('\ndescription: ');
    }
  });

  test('no command wraps a generator — x g is the one way, and a second one drifts', () => {
    const commands = claudeFiles(app)
      .filter((file) => file.path.startsWith('.claude/commands/'))
      .map((file) => file.path);
    for (const banned of ['new-model', 'new-route', 'new-service', 'generate'])
      expect(commands.some((path) => path.includes(banned))).toBe(false);
  });
});
