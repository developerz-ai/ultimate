import { describe, expect, test } from 'bun:test';
import { UnknownCommandError } from './errors';
import type { CommandSpec } from './parse';
import { flagBool, flagString, parseArgs } from './parse';
import { SPECS as SPECS_SHIPPED } from './registry';
import { thrownBy } from './thrown-by';

const SPECS: readonly CommandSpec[] = [
  // `verify` really does declare no flags — narrowing the gate would make "green" mean whatever
  // the caller chose (axiom 5), so the fixture carries no `--only`/`--skip` either.
  { name: 'verify', summary: 'the gate', usage: 'x verify', flags: [] },
  {
    name: 'db',
    summary: 'database',
    usage: 'x db <sub>',
    subcommands: ['gen', 'migrate', 'branch'],
    flags: [{ name: 'name', type: 'string', summary: 'migration or branch name' }],
  },
  { name: 'g', aliases: ['generate'], summary: 'scaffold', usage: 'x g <kind> <name>' },
  { name: 'help', summary: 'help', usage: 'x help' },
  { name: 'version', summary: 'version', usage: 'x version' },
];

describe('unit · parseArgs', () => {
  test('reads a command, its subcommand and its positionals', () => {
    const args = parseArgs(['db', 'branch', 'feat-billing'], SPECS);
    expect(args.command).toBe('db');
    expect(args.subcommand).toBe('branch');
    expect(args.positionals).toEqual(['feat-billing']);
  });

  // Array order is not a declaration. `x db` ran `gen` — a code GENERATOR that writes migration
  // files — because it sorted first in `DB_SUBCOMMANDS`, and no caller ever asked for it.
  test('a command that declares no default subcommand refuses a bare invocation', () => {
    const error = thrownBy(() => parseArgs(['db'], SPECS));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.cause).toContain('gen, migrate, branch');
    expect(error.fix).toBe('x help db');
    // `x db --help` is the OTHER way to the same page, and it used to throw this same error — the
    // subcommand was resolved after the flag loop and `--help` never got a chance to answer.
    expect(parseArgs(['db', '--help'], SPECS).help).toBe(true);
  });

  test('a declared default subcommand is the one that answers a bare invocation', () => {
    const specs: readonly CommandSpec[] = [
      { ...(SPECS[1] as CommandSpec), defaultSubcommand: 'migrate' },
    ];
    expect(parseArgs(['db'], specs).subcommand).toBe('migrate');
  });

  // Against the REAL registry, because the rule is about what ships: a default nobody can reach
  // is the same class of dead declaration as `x db`'s `?? 'migrate'` was.
  test('every shipped default subcommand is one the command actually declares', () => {
    for (const spec of SPECS_SHIPPED) {
      if (spec.defaultSubcommand === undefined) continue;
      expect(spec.subcommands ?? []).toContain(spec.defaultSubcommand);
    }
  });

  // The exact set, so adding or removing one is a deliberate edit and not a side effect of an
  // array's order. `x db gen` writes a migration file and `x db reset` drops the database; a bare
  // `x mcp` used to START A SERVER, which is the one thing a word typed by mistake must not do.
  // `x pr` joined them in 6.1.0: two of its three subcommands WRITE to somebody else's pull request
  // — `resolve` closes a thread and `reply` posts a comment under your name — and neither is
  // undoable by re-running the command. A default of `review` would read as the safe choice and is
  // not the point: the point is that a mistyped word must not reach a subcommand at all.
  test('exactly the commands whose bare form is dangerous refuse it', () => {
    const refusing = SPECS_SHIPPED.filter(
      (spec) => (spec.subcommands ?? []).length > 0 && spec.defaultSubcommand === undefined,
    ).map((spec) => spec.name);
    expect(refusing.sort()).toEqual(['db', 'mcp', 'pr']);
  });

  test('accepts --json on every command and exposes it as a boolean', () => {
    // `db` carries its subcommand: it declares no default, so the bare form is refused — and that
    // refusal is still rendered as JSON, by `wantsJson` on raw argv in `dispatch`.
    for (const argv of [['verify'], ['db', 'migrate'], ['g']]) {
      expect(parseArgs([...argv, '--json'], SPECS).json).toBe(true);
    }
    expect(parseArgs(['verify'], SPECS).json).toBe(false);
    expect(parseArgs(['verify', '-j'], SPECS).json).toBe(true);
  });

  test('reads string flags in both --flag value and --flag=value form', () => {
    expect(flagString(parseArgs(['db', 'branch', '--name', 'feat-billing'], SPECS), 'name')).toBe(
      'feat-billing',
    );
    expect(flagString(parseArgs(['db', 'branch', '--name=feat-billing'], SPECS), 'name')).toBe(
      'feat-billing',
    );
  });

  test('--no-<flag> turns a boolean off', () => {
    expect(flagBool(parseArgs(['verify', '--no-verbose'], SPECS), 'verbose')).toBe(false);
    expect(flagBool(parseArgs(['verify', '--verbose'], SPECS), 'verbose')).toBe(true);
  });

  test('resolves aliases to the canonical command name', () => {
    expect(parseArgs(['generate', 'action', 'publishPost'], SPECS).command).toBe('g');
  });

  test('everything after -- is passthrough, not a flag', () => {
    const args = parseArgs(['db', 'branch', '--', '--name', 'nonsense'], SPECS);
    expect(args.passthrough).toEqual(['--name', 'nonsense']);
    expect(flagString(args, 'name')).toBeUndefined();
  });

  test('an unknown command throws X_CLI_UNKNOWN_COMMAND with a suggestion', () => {
    expect(() => parseArgs(['verfy'], SPECS)).toThrow(UnknownCommandError);
    const failure = thrownBy(() => parseArgs(['verfy'], SPECS));
    expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(failure.fix).toBe('x verify');
  });

  test('an unknown subcommand names the command path, not just the token', () => {
    const failure = thrownBy(() => parseArgs(['db', 'frobnicate'], SPECS));
    expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(String(failure.cause)).toContain('db frobnicate');
  });

  test('an unknown flag throws X_CLI_BAD_FLAG pointing at the command help', () => {
    const failure = thrownBy(() => parseArgs(['verify', '--onl', 'lint'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x verify --help');
  });

  test('a string flag with no value is an error, not a silent empty string', () => {
    const failure = thrownBy(() => parseArgs(['db', 'branch', '--name'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(String(failure.cause)).toContain('expects a value');
  });

  // `nearest` answers nothing for a token that resembles no command, and the two arms differ:
  // one names a `suggestion`, the other must not invent one. A `did you mean` pointing at an
  // unrelated command is worse than none — it is an instruction that runs the wrong thing.
  test('a command that resembles nothing is refused with no suggestion at all', () => {
    const failure = thrownBy(() => parseArgs(['zzzzzzzzzz'], SPECS));
    expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(failure.cause).toBe(
      '"x zzzzzzzzzz" is not a command (known: verify, db, g, help, version)',
    );
    expect(failure.fix).toBe('x help');
    // and the near-miss arm still suggests.
    expect(thrownBy(() => parseArgs(['verifyy'], SPECS)).fix).toBe('x verify');
  });

  test('a subcommand that resembles nothing is refused with no suggestion either', () => {
    const failure = thrownBy(() => parseArgs(['db', 'zzzzzzzzzz'], SPECS));
    expect(failure.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(failure.cause).toBe('"x db zzzzzzzzzz" is not a command (known: gen, migrate, branch)');
    expect(failure.fix).toBe('x help');
    // and the near-miss arm names the command AND the subcommand, never the subcommand alone.
    expect(thrownBy(() => parseArgs(['db', 'migrat'], SPECS)).fix).toBe('x db migrate');
  });

  test('a boolean flag given a value is refused, never read as the string', () => {
    for (const argv of [
      ['verify', '--json=true'],
      ['verify', '--json=false'],
      ['verify', '--json='],
    ]) {
      const failure = thrownBy(() => parseArgs(argv, SPECS));
      expect([argv.join(' '), failure.code]).toEqual([argv.join(' '), 'X_CLI_BAD_FLAG']);
      expect([argv.join(' '), failure.cause]).toEqual([
        argv.join(' '),
        '--json on "x verify": boolean flag takes no value',
      ]);
    }
    // The bare form is what a boolean takes.
    expect(parseArgs(['verify', '--json'], SPECS).json).toBe(true);
  });

  test('bare argv and --help both route to the help command', () => {
    expect(parseArgs([], SPECS).command).toBe('help');
    expect(parseArgs(['--help'], SPECS).command).toBe('help');
    expect(parseArgs(['help', 'db'], SPECS).positionals).toEqual(['db']);
    expect(parseArgs(['--version'], SPECS).command).toBe('version');
  });
});

/**
 * The four rules about a flag's RELATIONSHIP to the rest of argv: `--help` outranks a missing
 * subcommand, a value that looks like a flag is refused with the form that would pass it, `--no-`
 * belongs to booleans, and a flag one subcommand declares is refused under the others. Each one
 * shipped as a silent wrong answer rather than a refusal, which is the direction that costs a file.
 */
describe('unit · parseArgs · flags against the rest of argv', () => {
  test('--help is honoured before a missing subcommand is refused', () => {
    for (const token of ['--help', '-h']) {
      const args = parseArgs(['db', token], SPECS);
      expect([token, args.command, args.help]).toEqual([token, 'db', true]);
    }
    // Every shipped command that takes a subcommand, because the defect was in the parser and so
    // was every one of them: `x db --help`, `x mcp --help`, `x pr --help` all exited 1.
    for (const spec of SPECS_SHIPPED) {
      if ((spec.subcommands ?? []).length === 0) continue;
      expect([spec.name, parseArgs([spec.name, '--help'], SPECS_SHIPPED).help]).toEqual([
        spec.name,
        true,
      ]);
    }
  });

  test('a value that begins with -- is refused with the form that would pass it', () => {
    const failure = thrownBy(() => parseArgs(['db', 'branch', '--name', '--json'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toBe(
      '--name on "x db": expects a value, and "--json" is a flag — write --name=--json to pass it as the value',
    );
  });

  test('--no- on a string flag is refused, never read as its value', () => {
    const failure = thrownBy(() => parseArgs(['db', 'branch', '--no-name', 'feat-billing'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toBe(
      '--name on "x db": --no- negates a boolean flag, and --name takes a value',
    );
    expect(failure.fix).toBe('x db --help');
  });

  test('a flag a subcommand does not read is refused, not ignored', () => {
    const specs: readonly CommandSpec[] = [
      {
        name: 'db',
        summary: 'database',
        usage: 'x db <sub>',
        subcommands: ['gen', 'seed', 'backfill'],
        flags: [
          { name: 'dry-run', type: 'boolean', summary: 'seed: …', subcommands: ['seed'] },
          { name: 'status', type: 'string', summary: 'backfill: …', subcommands: ['backfill'] },
        ],
      },
    ];
    const failure = thrownBy(() => parseArgs(['db', 'gen', 'add publish_at', '--dry-run'], specs));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toBe(
      '--dry-run on "x db gen": read by x db seed only — "gen" would ignore it',
    );
    // Runnable, and it carries the caller's own value: a `fix:` is pasted into a shell verbatim.
    expect(failure.fix).toBe('x db seed --dry-run');
    expect(thrownBy(() => parseArgs(['db', 'gen', '--status', 'a b'], specs)).fix).toBe(
      "x db backfill --status 'a b'",
    );
    // The subcommand that DOES declare it still takes it, and an undeclared flag is unrestricted.
    expect(flagBool(parseArgs(['db', 'seed', '--dry-run'], specs), 'dry-run')).toBe(true);
    // `--help` outranks this too: usage must be readable from any invocation.
    expect(parseArgs(['db', 'gen', '--dry-run', '--help'], specs).help).toBe(true);
  });

  /**
   * The mechanical half of the rule, over every shipped command. A flag summary that opens
   * `<subcommand>:` is a claim about which invocation reads it — `x db`'s nine, `x jobs`'
   * four, `x tasks`' one, `x pr`'s three — and prose drifts in silence. `subcommands` is what
   * the parser reads, so this is what holds the two to one fact.
   *
   * `x g` is deliberately out of scope and is the one shape this cannot judge: it declares
   * `positionalChoices` and NO subcommands, so `resource:` / `admin:page:` in `cmd-generate.ts`
   * name a positional rather than a subcommand, and `parseArgs` has no word to validate against
   * at the point this check runs.
   */
  test('a flag summary that names a subcommand is scoped to that subcommand', () => {
    for (const spec of SPECS_SHIPPED) {
      const subcommands: readonly string[] = spec.subcommands ?? [];
      for (const flag of spec.flags ?? []) {
        const prefix = flag.summary.split(':')[0] ?? '';
        if (!subcommands.includes(prefix)) continue;
        expect([spec.name, flag.name, flag.subcommands]).toEqual([spec.name, flag.name, [prefix]]);
      }
    }
  });

  // Well-formedness of the declaration itself: a flag scoped to a word its command does not
  // declare is a flag no invocation can ever pass, which is worse than an unscoped one.
  test('every shipped flag scope names subcommands its command actually declares', () => {
    for (const spec of SPECS_SHIPPED) {
      for (const flag of spec.flags ?? []) {
        if (flag.subcommands === undefined) continue;
        expect([spec.name, flag.name, flag.subcommands.length > 0]).toEqual([
          spec.name,
          flag.name,
          true,
        ]);
        for (const sub of flag.subcommands) {
          expect([spec.name, flag.name, sub, (spec.subcommands ?? []).includes(sub)]).toEqual([
            spec.name,
            flag.name,
            sub,
            true,
          ]);
        }
      }
    }
  });
});

describe('unit · a default subcommand that takes the first positional', () => {
  // `x errors X_PERMISSION_UNKNOWN --json` answered `X_CLI_UNKNOWN_COMMAND … fix: x help`, and
  // `x help` prints `errors  an X_* code, explained` — the fix led straight back to the form that
  // had just been refused (#F16). The declaration is per command because most commands cannot say
  // it truthfully: `x jobs 4f2a` is ambiguous with `show`.
  const SPEC: readonly CommandSpec[] = [
    {
      name: 'errors',
      summary: 'an X_* code, explained',
      usage: 'x errors [explain <CODE>|list]',
      subcommands: ['explain', 'list'],
      defaultSubcommand: 'explain',
      defaultSubcommandTakesPositional: true,
    },
    {
      name: 'jobs',
      summary: 'the queue',
      usage: 'x jobs [ls|show <id>]',
      subcommands: ['ls', 'show'],
      defaultSubcommand: 'ls',
    },
  ];

  test('an unrecognised first word becomes the default subcommand’s argument', () => {
    const args = parseArgs(['errors', 'X_PERMISSION_UNKNOWN', '--json'], SPEC);
    expect(args.subcommand).toBe('explain');
    // The word is NOT eaten: a default nobody typed leaves its positional in place.
    expect(args.positionals).toEqual(['X_PERMISSION_UNKNOWN']);
  });

  test('a typed subcommand still consumes its own word', () => {
    const args = parseArgs(['errors', 'explain', 'X_DB_DRIFT'], SPEC);
    expect(args.subcommand).toBe('explain');
    expect(args.positionals).toEqual(['X_DB_DRIFT']);
  });

  test('a near miss is still refused, with the suggestion — never read as an argument', () => {
    const error = thrownBy(() => parseArgs(['errors', 'explan', 'X_DB_DRIFT'], SPEC));
    expect(error).toBeInstanceOf(UnknownCommandError);
    expect((error as UnknownCommandError).fix).toContain('errors explain');
  });

  test('a command that did not declare it keeps refusing, so x jobs <id> is never a silent ls', () => {
    expect(thrownBy(() => parseArgs(['jobs', '4f2a9c'], SPEC))).toBeInstanceOf(UnknownCommandError);
  });

  test('the bare form is unchanged — the default runs with no positional', () => {
    const args = parseArgs(['errors'], SPEC);
    expect(args.subcommand).toBe('explain');
    expect(args.positionals).toEqual([]);
  });

  // The shipped registry, not the fixture: `errors` is the ONE command that declares this today,
  // and a second one arriving silently is a change to how every typo in it is read.
  test('exactly one shipped command declares it', () => {
    expect(
      SPECS_SHIPPED.filter((spec) => spec.defaultSubcommandTakesPositional === true).map(
        (spec) => spec.name,
      ),
    ).toEqual(['errors']);
  });
});
