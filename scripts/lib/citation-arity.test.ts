// A citation's bare words held to what the registry's usage line declares. The motivating case is
// `x routes list --json`: the parser ignored the stray `list`, so a retired spelling stayed in three
// route-miss fix lines and resolved clean against a rule that read only the command name.

import { describe, expect, test } from 'bun:test';
import type { CommandCatalog } from '../../packages/cli/src/fix-command';
import type { CommandSpec } from '../../packages/cli/src/parse';
import { arityFault, citationWords, usageForms } from './citation-arity';

const spec = (name: string, usage: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
  name,
  summary: '',
  usage,
  ...extra,
});

const SPECS: readonly CommandSpec[] = [
  spec('routes', 'x routes [--surface site|app|api|shared] [--json]', {
    flags: [{ name: 'surface', type: 'string', summary: '' }],
  }),
  spec('new', 'x new <name> [--dir path] [--no-example] [--json]', {
    flags: [
      { name: 'dir', type: 'string', summary: '' },
      { name: 'example', type: 'boolean', summary: '' },
    ],
  }),
  spec('errors', 'x errors [explain <CODE>|list] [--json]', {
    subcommands: ['explain', 'list'],
    defaultSubcommand: 'explain',
    defaultSubcommandTakesPositional: true,
  }),
  spec(
    'verify',
    'x verify [--only <step>[,<step>…] [--shard i/n]] [--json] · x verify merge <part.json…> [--json]',
    {
      subcommands: ['run', 'merge'],
      defaultSubcommand: 'run',
      flags: [
        { name: 'only', type: 'string', summary: '' },
        { name: 'shard', type: 'string', summary: '' },
      ],
    },
  ),
  spec(
    'db',
    'x db gen "add publish_at" | migrate | seed [<name>] [--tier reference|dev] | branch ls | branch drop <name>',
    {
      subcommands: ['gen', 'migrate', 'seed', 'branch'],
      subcommandPositionals: { branch: ['ls', 'create', 'drop'] },
      flags: [{ name: 'tier', type: 'string', summary: '' }],
    },
  ),
  spec('help', 'x help [command] [--json]'),
  spec('jobs', 'x jobs [ls|show <id>|drain --to <driver>] [--json]', {
    subcommands: ['ls', 'show', 'drain'],
    defaultSubcommand: 'ls',
    flags: [{ name: 'to', type: 'string', summary: '' }],
  }),
  spec('g', 'x g resource|action <name> [--feature f]', {
    positionalChoices: ['resource', 'action'],
    flags: [{ name: 'feature', type: 'string', summary: '' }],
  }),
];

const catalog: CommandCatalog = { specs: SPECS, planned: new Set(), plannedSubcommands: new Set() };
const fault = (fix: string) => arityFault(fix, catalog);

describe('a stray positional is a finding', () => {
  test('`x routes list --json` — routes takes none', () => {
    expect(fault('`x routes list --json`')).toEqual({
      subject: 'x routes list',
      reason:
        'and routes takes no positional word (usage: x routes [--surface site|app|api|shared] [--json])',
    });
  });

  test('one word too many past a declared positional', () => {
    expect(fault('x new my-app extra')?.subject).toBe('x new my-app extra');
    expect(fault('x errors explain X_A X_B')?.subject).toBe('x errors explain X_A X_B');
    expect(fault('x db branch drop main again')?.subject).toBe('x db branch drop main again');
  });
});

describe('every documented shape still resolves', () => {
  test.each([
    'x routes --json',
    'x routes --surface app --json',
    'x new my-app --dir apps/x',
    'x errors explain X_FOO --json',
    'x errors X_FOO',
    'x errors list',
    'x verify --only lint,typecheck --json',
    'x verify merge a.json b.json c.json',
    'x verify run',
    'x db gen "add index"',
    'x db seed demo --tier dev',
    'x db branch ls',
    'x db branch drop <name>',
    'x help verify',
    'x jobs show 4f2a',
    'x jobs drain --to pg',
    'x g resource post --feature blog',
    'x routes --json, then read the table',
    'x routes --json # list',
    '`x routes --json` and `x new a`',
    'x unknown thing here',
  ])('%s', (fix) => {
    expect(fault(fix)).toBeUndefined();
  });
});

describe('reading the two sides', () => {
  test('a citation stops at punctuation, a quote, a comment and the next citation', () => {
    expect(citationWords('x routes --json, then list them', 'routes')).toEqual([]);
    expect(citationWords('x new a; x routes b', 'new')).toEqual(['a']);
    expect(citationWords('x new a b.', 'new')).toEqual(['a', 'b']);
    expect(citationWords('x jobs cancel <the job id> now', 'jobs')).toEqual([
      'cancel',
      '<the_job_id>',
      'now',
    ]);
  });

  test('only the words before the first flag are positionals — prose follows a flag', () => {
    expect(citationWords('x new my-app --dir out extra', 'new')).toEqual(['my-app']);
    expect(citationWords('x routes --json lists them', 'routes')).toEqual([]);
    expect(citationWords('x test <type> [--filter <text>]', 'test')).toEqual(['<type>']);
    expect(citationWords('x verify > part.json', 'verify')).toEqual([]);
    expect(citationWords('x new a — then b', 'new')).toEqual(['a']);
    expect(citationWords('no citation here', 'new')).toEqual([]);
  });

  test('an elided `…` is not counted, and a placeholder with spaces is one word', () => {
    expect(fault('`x g … --force`')).toBeUndefined();
    expect(fault('`x new <the app name>`')).toBeUndefined();
  });

  test('the usage line becomes the slot sequences it allows', () => {
    const forms = usageForms(SPECS[2] as CommandSpec).map((form) =>
      form.slots.map((slot) => slot.literals?.join('|') ?? (slot.variadic ? '…' : '_')).join(' '),
    );
    expect(forms).toContain('explain _');
    expect(forms).toContain('list');
    expect(forms).toContain('');
    const verify = usageForms(SPECS[3] as CommandSpec).map((form) => form.slots.length);
    expect(verify).toContain(0);
  });
});
