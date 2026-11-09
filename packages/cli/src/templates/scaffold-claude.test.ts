// A scaffolded file that names an `x` command this build does not ship is broken, not merely long:
// the agent reading it runs the line and gets "no such command". Same failure `cmd-planned.test.ts`
// closes for the planned table, applied to the prose `x new` writes — every `x …` in it, `.claude/`
// and the docs beside it alike, must resolve to a shipped command and a real subcommand.

import { describe, expect, test } from 'bun:test';
import type { ValidationIssue } from '@ultimat3/schema';
import { parse, t, ValidationFailedError } from '@ultimat3/schema';
import { verifySpec } from '../cmd-verify-spec';
import { SPECS } from '../registry';
import { LINE_CEILING } from '../workspace-checks';
import { names } from './naming';
import { claudeFiles } from './scaffold-claude';
import { docsFiles } from './scaffold-docs';

const app = names('ledger-demo');

const fileAt = (path: string): string =>
  String(claudeFiles(app).find((file) => file.path === path)?.contents ?? '');

/**
 * The shape the harness itself reads. Parsed rather than asserted, so a settings file that loses
 * `permissions.allow` fails naming that path — an `as` cast turns the same regression into a
 * `TypeError` on a property access, which is a failure diagnosable only by reading three files.
 */
const Settings = t.object({
  permissions: t.object({ allow: t.array(t.string) }),
  hooks: t.object({
    PostToolUse: t.array(
      t.object({
        matcher: t.string,
        hooks: t.array(t.object({ type: t.string, command: t.string })),
      }),
    ),
  }),
});

function parseSettings() {
  const source: unknown = JSON.parse(fileAt('.claude/settings.json'));
  return parse(Settings, source, '.claude/settings.json');
}

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

  test('the settings parse is what fails when the shape moves, and it names the path', () => {
    // Without this the schema above is decoration: the assertions below would still read a plain
    // cast, and a settings file that dropped `permissions.allow` would surface as a TypeError.
    let issues: readonly ValidationIssue[] = [];
    try {
      parse(Settings, { permissions: {}, hooks: { PostToolUse: [] } }, '.claude/settings.json');
    } catch (error) {
      issues = error instanceof ValidationFailedError ? error.issues : [];
    }
    expect(issues.map((issue) => issue.path)).toContain('permissions.allow');
  });

  test('settings.json parses, and allows nothing destructive', () => {
    const allow = parseSettings().permissions.allow;
    expect(allow.length).toBeGreaterThan(0);
    // Each of these either drops data, writes production or decrypts secrets. An allowlist that
    // pre-approves one turns the permission prompt into the thing nobody reads.
    for (const forbidden of ['db reset', 'backfill', 'secrets', 'deploy', 'git push', 'git commit'])
      expect(allow.some((rule) => rule.includes(forbidden))).toBe(false);
  });

  test('every x rule is spelled bunx x — the spelling that runs with no global x', () => {
    // A permission for `x verify` pre-approves a command that cannot run in a fresh app, and leaves
    // the one that can — `bunx x verify`, what the generators print — behind a prompt.
    const allow = parseSettings().permissions.allow;
    expect(allow.filter((rule) => rule.startsWith('Bash(x '))).toEqual([]);
    expect(allow).toContain('Bash(bunx x verify:*)');
    expect(allow).toContain('Bash(bunx x g:*)');
  });

  test('the workflow commands and subagents spell every command they run as bunx x', () => {
    const commands = claudeFiles(app).filter(
      (file) =>
        file.path.startsWith('.claude/commands/') || file.path.startsWith('.claude/agents/'),
    );
    expect(commands.some((file) => file.path.startsWith('.claude/agents/'))).toBe(true);
    for (const file of commands) {
      const text = String(file.contents);
      expect({ path: file.path, bare: text.match(/`x [a-z]/g) ?? [] }).toEqual({
        path: file.path,
        bare: [],
      });
      expect(text.split('\n').filter((line) => /^x [a-z]/.test(line))).toEqual([]);
    }
  });

  test('exactly one PostToolUse hook, and it names a binary the scaffold installs', () => {
    const hooks = parseSettings().hooks.PostToolUse.flatMap((entry) => entry.hooks);
    expect(hooks).toHaveLength(1);
    // biome is a devDependency `x new` writes into the root package.json: a hook runs on every
    // edit, and even `x verify --only lint` is a whole-tree pass, too slow to run per file.
    expect(hooks[0]?.command).toContain('biome');
  });

  test('the hook rewrites files, and the README is where that is disclosed', () => {
    // JSON carries no comment, so the only place a reader can learn that `check` writes is the
    // README next to it. Pinned, because an undisclosed hook is the one thing in this bundle that
    // acts on the user's tree without saying so.
    const readme = fileAt('.claude/README.md');
    expect(readme).toContain('--write');
    expect(readme).toContain('in place');
    expect(parseSettings().hooks.PostToolUse[0]?.hooks[0]?.command).toContain('--write');
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

// --------------------------------------------------------------------------------------------
// The rules table an app is born with. A rule the gate refuses and the table omits is worse than
// an unenforced rule: the author finds out it exists when the gate goes red on work already done.
// --------------------------------------------------------------------------------------------

describe('unit · the generated AGENTS.md names every rule the gate actually refuses', () => {
  // `contents` is `string | Uint8Array` because the same shape carries binary files; AGENTS.md is
  // prose, and a test that asserted over the union would be asserting about the wrong thing.
  const agentsMd = (): string => {
    const file = docsFiles(app).find((generated) => generated.path === 'AGENTS.md');
    if (file === undefined) expect.unreachable('x new writes no AGENTS.md');
    if (typeof file.contents !== 'string')
      expect.unreachable('AGENTS.md is generated as bytes, not prose');
    return file.contents;
  };

  test('the line ceiling has a row, with the code that refuses it', () => {
    // It is enforced by `checkFileSizes` and was in no row for the whole life of the template, so
    // the first an author heard of a 500-line ceiling was `X_FILE_TOO_LONG` on a finished file.
    const text = agentsMd();
    expect(text).toContain('X_FILE_TOO_LONG');
    expect(text).toContain(String(LINE_CEILING));
  });

  test('the ceiling in the prose is the ceiling in the code, not a number that drifted', () => {
    const text = agentsMd();
    const rows = text.split('\n').filter((line) => line.includes('X_FILE_TOO_LONG'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(String(LINE_CEILING));
    // The ROW is not the only place the number appears: the paragraph under the table explains
    // the rule and names it again. Both are interpolated from `LINE_CEILING`, and this is what
    // says so — a table generated from the constant beside prose that hard-codes 500 drifts the
    // moment the ceiling moves, and the prose is the half a reader believes.
    expect(text).toContain(`past ${LINE_CEILING} lines`);
    // Two sites, both generated: any third occurrence is a number someone typed.
    expect(text.split(String(LINE_CEILING))).toHaveLength(3);
  });

  test('the one exemption is named, so a re-export manifest is not filed as a bug', () => {
    expect(agentsMd()).toContain('re-exports');
  });
});

describe("unit · what the bundle says about `x verify`'s flags is true", () => {
  // It said "there is no `--only`" while `x verify --only <step>` shipped (D6): an agent told the
  // flag does not exist never narrows its feedback, and one that finds it learns the file lies.
  const shipped = new Set(verifySpec.flags?.map((flag) => flag.name) ?? []);
  const denied = (text: string): readonly string[] =>
    [...text.matchAll(/no `--([a-z-]+)`/g)].map((match) => match[1] ?? '');

  test('the check reads a denial', () => {
    expect(denied('there is no `--only` and no `--skip`')).toEqual(['only', 'skip']);
  });

  test('no flag `x verify` ships is said not to exist', () => {
    const text = textOf(claudeFiles(app));
    expect(denied(text).filter((flag) => shipped.has(flag))).toEqual([]);
    // And the one narrowing is named for what it is: feedback, never the verdict.
    expect(text).toContain('NOT A GATE RUN');
  });
});
