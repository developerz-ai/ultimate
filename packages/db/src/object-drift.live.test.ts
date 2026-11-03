// Single responsibility: every `unexpected-object` fix is a line a real shell and a real `psql`
// run — one object of each kind, made by hand in a schema the session's search_path does NOT
// hold, read back through `introspectCatalog`, and its rendered fix executed as written.
//
// The gate is `TEST_DATABASE_URL` alone, like every other live suite in this package: the HOST
// `psql` client is a convenience, not the subject. Where it is missing the fix's show target is
// resolved against the LIVE CATALOG instead — the same object, the same definition, the same
// token — so a missing host tool costs the suite nothing and skips it nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun's only file read is `Bun.file().text()`, and it is a promise — this assertion reads
// its own source synchronously, inside a synchronous test body.
import { readFileSync } from 'node:fs';
import {
  type CatalogDescription,
  type CatalogDomain,
  type CatalogEnum,
  emptyCatalog,
} from './catalog';
import { type PostgresClient, postgresClient } from './client';
import type { DriftDifference } from './drift-findings';
import { introspectCatalog } from './introspect-catalog';
import { unexpectedObjects } from './object-drift';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const SCHEMA = 'objdrift_schema';
const S = `"${SCHEMA}"`;

const SETUP = [
  `create type ${S}.od_mood as enum ('fine', 'grim')`,
  `create domain ${S}.od_email as text check (value like '%@%')`,
  `create sequence ${S}.od_seq maxvalue 9`,
  `create table ${S}.od_posts (id int)`,
  `create view ${S}.od_report as select id as report_id from ${S}.od_posts`,
  `create materialized view ${S}.od_totals as select count(*) as total_n from ${S}.od_posts`,
  `create function ${S}.od_touch() returns trigger language plpgsql as 'begin return new; end'`,
  // An argument of the schema's OWN type, so its identity arguments are spelled by search_path.
  `create function ${S}.od_label(a text, m ${S}.od_mood) returns text language sql as 'select a || ''-here'''`,
  `create trigger od_posts_touch before update on ${S}.od_posts for each row execute function ${S}.od_touch()`,
  // The decoy: same name and arguments in a schema the session DOES see.
  `create function public.od_touch() returns trigger language plpgsql as 'begin return null; end'`,
];

/** What each kind's command must put on the screen: the thing a migration would be copied from. */
const SHOWS: Readonly<Record<string, string>> = {
  'type "od_mood"': 'grim',
  'domain "od_email"': 'CHECK',
  'sequence "od_seq"': 'bigint',
  'view "od_report"': 'report_id',
  'materialized view "od_totals"': 'total_n',
  'function "od_touch"': 'return new',
  'function "od_label"': '-here',
  'trigger "od_posts_touch"': 'od_posts_touch',
};

/**
 * What the suite can prove, as three distinct outcomes — never two that read alike. The gate
 * counts SKIPS, so a suite that stands down for two different reasons reports one silent
 * number, and a ratchet (`X_VERIFY_SUITE_VANISHED`) cannot tell "no database" from "no host
 * tool". Each outcome says which.
 */
export type SuiteOutcome =
  | 'database-unavailable'
  | 'configured-without-psql'
  | 'configured-with-psql';

/** The one reader of "what can this run prove". `psql` is the path of the host client. */
export const suiteOutcome = (
  databaseUrl: string | undefined,
  psqlPath: string | null,
): SuiteOutcome => {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) return 'database-unavailable';
  return psqlPath === null ? 'configured-without-psql' : 'configured-with-psql';
};

/**
 * The suite's GATE, and it is asked ONE question: is there a DATABASE? It takes the URL and
 * nothing else — the host tool cannot reach it, so a missing `psql` changes WHAT the suite
 * proves, never WHETHER it runs. A gate that asked for the host tool would take the whole suite
 * down — and every kind in `SHOWS` with it — on a machine that has a database and no `psql`.
 */
export const suiteRuns = (databaseUrl: string | undefined): boolean =>
  suiteOutcome(databaseUrl, null) !== 'database-unavailable';

/** This run's outcome — read ONCE, and the only thing the branches ask. */
const outcome = suiteOutcome(url, Bun.which('psql'));

/** This run's gate: the database, and never the host tool. */
const gated = suiteRuns(url);

/** The line, through `sh`, with NOTHING putting the schema on the search_path. */
const run = async (line: string): Promise<readonly [number, string, string]> => {
  const shell = Bun.spawn(['sh', '-c', line], {
    env: { ...Bun.env, DATABASE_URL: url ?? '', PGOPTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(shell.stdout).text(),
    new Response(shell.stderr).text(),
  ]);
  return [await shell.exited, out, err];
};

/**
 * The `-c` argument of a `fix:` line, as the SHELL hands it to `psql`: a stub `psql` prints the
 * word it was called with, and the line is read by the shell that would run it.
 *
 * A regex over the line cannot answer this. A fix whose own quoting is broken — a `'` the writer
 * did not escape — reads as ONE SQL and hands `psql` ANOTHER: the quote closed the word, and the
 * text after it became more words. A query run on the line's text then passes while the pasted fix
 * sends something else, which is the whole subject of this suite.
 */
const shellWord = async (fix: string): Promise<string | undefined> => {
  const [, out] = await run(`psql() { printf '%s' "$3"; }; ${fix}`);
  return out === '' ? undefined : out;
};

/** The meta-command a fix names: `\dT+ "schema"."name"`, `\d "schema"."table"`. */
interface ShowTarget {
  readonly command: string;
  readonly schema: string;
  readonly name: string;
}

const showTarget = (argument: string): ShowTarget | undefined => {
  const match = /^(\\[a-zA-Z]+\+?)\s+"([^"]+)"\."([^"]+)"$/.exec(argument);
  if (match === null) return undefined;
  return { command: match[1] ?? '', schema: match[2] ?? '', name: match[3] ?? '' };
};

/** The one value a one-column `select` returned, whatever the server called the column. */
const singleValue = (row: Record<string, unknown> | undefined): string => {
  if (row === undefined) return '';
  const [first] = Object.values(row);
  return typeof first === 'string' ? first : '';
};

describe('the object-drift live suite’s own gate', () => {
  // Ungated on purpose: this file must still RUN its cases with no database and no `psql`.
  test('three outcomes, and no two of them alike', () => {
    expect(suiteOutcome(undefined, '/usr/bin/psql')).toBe('database-unavailable');
    expect(suiteOutcome('', '/usr/bin/psql')).toBe('database-unavailable');
    expect(suiteOutcome('postgres://localhost/db', null)).toBe('configured-without-psql');
    expect(suiteOutcome('postgres://localhost/db', '/usr/bin/psql')).toBe('configured-with-psql');
    // The middle one is the point: a CONFIGURED database with the host tool missing is not the
    // same silence as no database at all, and the suite still proves everything it can.
    expect(suiteOutcome('postgres://localhost/db', null)).not.toBe(suiteOutcome(undefined, null));
  });

  test('the gate this run really has', () => {
    expect(outcome).toBe(suiteOutcome(Bun.env['TEST_DATABASE_URL'], Bun.which('psql')));
    // The gate is the outcome's DATABASE arm: the host-tool arm decides what the suite proves,
    // never whether it runs.
    expect(gated).toBe(outcome !== 'database-unavailable');
  });

  test('the gate is the DATABASE alone: the host tool never takes the suite down', () => {
    // A CONFIGURED database gates the suite whether the host tool is there or not — a missing
    // `psql` changes what the suite proves, never whether it runs. A gate that asked for the
    // host tool would take every kind in `SHOWS` down with it.
    expect(suiteRuns('postgres://localhost/db')).toBe(true);
    // And NO database takes it down, psql or not.
    expect(suiteRuns(undefined)).toBe(false);
    expect(suiteRuns('')).toBe(false);
  });

  test('the gate the live block uses is the DATABASE arm, not the host tool', () => {
    // `gated` is what the skip condition reads, and it is the DATABASE's answer — the same
    // answer a configured URL earns on a machine with the host tool and on one without.
    expect(gated).toBe(suiteRuns(Bun.env['TEST_DATABASE_URL']));
  });

  test('the skip condition cannot see the host tool', () => {
    // The ratchet (`X_VERIFY_SUITE_VANISHED`) counts skips and cannot tell "no database" from
    // "no host tool", so the one thing that must not happen is the whole suite standing down
    // over a missing `psql`. The gate is a function of the URL, and the host tool reaches the
    // file only ONCE — to say what the suite CAN prove. Read the file's own text: a skip
    // condition that asked for `psql` would take every kind in `SHOWS` down with it.
    const source = readFileSync(`${import.meta.dir}/object-drift.live.test.ts`, 'utf8');
    const skip = /describe\.skipIf\(([^)]*)\)/.exec(source)?.[1] ?? '';
    // The WHOLE expression, not a scan for a tool name: a skip that asked for a renamed helper
    // (`!runnable`) names no tool at all, so the scan called that healthy. The expression IS the
    // gate, so the expression is what is pinned.
    expect(skip).toBe('!gated');
  });
});

describe.skipIf(!gated)('live · postgres · an unexpected-object fix runs as written', () => {
  let admin: PostgresClient;
  let live: CatalogDescription;

  /** The name of the object a difference names, out of its cause: `trigger "x" on table "y"`. */
  const named = (cause: string): string => /"([^"]+)"/.exec(cause)?.[1] ?? '';

  /**
   * The catalog's own text for the object a fix names — what `\d` would have printed, read from
   * the same `pg_get_*def` the catalog holds. The TARGET is resolved from the fix's own command,
   * so a fix that pointed elsewhere would resolve to nothing and fail.
   */
  const definitionIn = (target: ShowTarget, difference: DriftDifference): string | undefined => {
    if (target.schema !== SCHEMA) return undefined;
    if (target.command === '\\dT+') {
      const type = live.types.find(
        (one): one is CatalogEnum => one.kind === 'enum' && one.name === target.name,
      );
      return type === undefined ? undefined : type.labels.join(', ');
    }
    if (target.command === '\\dD+') {
      const domain = live.types.find(
        (one): one is CatalogDomain => one.kind === 'domain' && one.name === target.name,
      );
      return domain === undefined
        ? undefined
        : [domain.baseType, ...domain.checks.map((check) => check.definition)].join('\n');
    }
    if (target.command === '\\d') {
      // `\d` names a TRIGGER's TABLE and LISTS the trigger on it, definition included; for a
      // SEQUENCE it names the sequence. The KIND in the cause says which of the two this is.
      if (difference.cause.startsWith('trigger ')) {
        const trigger = live.triggers.find(
          (one) => one.table === target.name && one.name === named(difference.cause),
        );
        return trigger === undefined ? undefined : trigger.definition;
      }
      const sequence = live.sequences.find((one) => one.name === target.name);
      return sequence === undefined ? undefined : sequence.dataType;
    }
    if (target.command === '\\d+') {
      const view = live.views.find((one) => one.name === target.name);
      return view === undefined ? undefined : view.definition;
    }
    return undefined;
  };

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '' });
    await admin.execute(raw(`drop schema if exists ${S} cascade`));
    await admin.execute(raw('drop function if exists public.od_touch()'));
    await admin.execute(raw(`create schema ${S}`));
    for (const statement of SETUP) await admin.execute(raw(statement));
    live = await introspectCatalog({ client: admin, schema: SCHEMA });
  });

  afterAll(async () => {
    await admin.execute(raw(`drop schema if exists ${S} cascade`));
    await admin.execute(raw('drop function if exists public.od_touch()'));
    await admin.close();
  });

  test('the -c argument is the SHELL’s word, not the line’s text', async () => {
    // A fix whose own quoting is broken: the LINE reads `select 'x' as y`, and the shell hands
    // `psql` `select x as y` — the unescaped quote closed the word, and the text after it became
    // more words. A capture that read the line would hand the database SQL the pasted fix never
    // sends, and the query would pass while the fix was broken.
    const broken = `psql "$DATABASE_URL" -c 'select 'x' as y'   # a comment`;
    expect(await shellWord(broken)).toBe('select x as y');
    // And a well-formed fix: the shell undoes the `'\''` escaping and hands over the SQL itself.
    const wellFormed = `psql "$DATABASE_URL" -c 'select 1'   # a comment`;
    expect(await shellWord(wellFormed)).toBe('select 1');
  });

  test('each kind: the command exits 0, says nothing on stderr, and prints its definition', async () => {
    const differences = unexpectedObjects(live, emptyCatalog(SCHEMA));
    const seen: string[] = [];
    for (const difference of differences) {
      const subject = Object.keys(SHOWS).find((key) => difference.cause.startsWith(key));
      if (subject === undefined) continue;
      seen.push(subject);
      const token = SHOWS[subject] ?? '';
      if (outcome === 'configured-with-psql') {
        const [code, out, err] = await run(difference.fix);
        // `\d` on a name it cannot find exits 0 and complains on stderr — so stderr is the verdict.
        expect([subject, code, err]).toEqual([subject, 0, '']);
        expect(out, subject).toContain(token);
        continue;
      }
      // No `psql` on this machine: the SAME fix, resolved against the live catalog. A function's
      // command is plain SQL and runs verbatim; a meta-command names its target, and the catalog
      // holds that target's own definition.
      const argument = await shellWord(difference.fix);
      expect(argument, subject).toBeDefined();
      if (argument === undefined) continue;
      if (argument.startsWith('select ')) {
        const rows = await admin.query<Record<string, unknown>>(raw(argument));
        expect(singleValue(rows[0]), subject).toContain(token);
        continue;
      }
      const target = showTarget(argument);
      expect(target, subject).toBeDefined();
      if (target === undefined) continue;
      const definition = definitionIn(target, difference);
      expect(definition, subject).toBeDefined();
      expect(definition ?? '', subject).toContain(token);
    }
    expect(seen.sort()).toEqual(Object.keys(SHOWS).sort());
  });

  test('the function shown is the schema’s own, never a same-named one the session can see', async () => {
    const difference = unexpectedObjects(live, emptyCatalog(SCHEMA)).find((one) =>
      one.cause.startsWith('function "od_touch"'),
    );
    const fix = difference?.fix ?? '';
    if (outcome === 'configured-with-psql') {
      const [, out] = await run(fix);
      expect(out).toContain('return new');
      expect(out).not.toContain('return null');
      return;
    }
    // The decoy lives in `public`; the fix's own SQL names the schema, and it is run verbatim.
    const argument = await shellWord(fix);
    expect(argument).toBeDefined();
    const rows = await admin.query<Record<string, unknown>>(raw(argument ?? ''));
    expect(singleValue(rows[0])).toContain('return new');
    expect(singleValue(rows[0])).not.toContain('return null');
  });

  test('and the drop each comment names is a statement the server accepts', async () => {
    const drops = unexpectedObjects(live, emptyCatalog(SCHEMA))
      .map((one) => / run (drop [^;]+;) here/.exec(one.fix)?.[1])
      .filter((drop): drop is string => drop !== undefined);
    expect(drops).toContain(`drop domain ${S}."od_email";`);
    expect(drops).toContain(`drop trigger "od_posts_touch" on ${S}."od_posts";`);
    // Dependants first: the trigger before its function, the views before the table's column.
    const order = [
      'trigger',
      'materialized view',
      'view',
      'function',
      'domain',
      'type',
      'sequence',
    ];
    const ranked = [...drops].sort(
      (a, b) =>
        order.findIndex((kind) => a.startsWith(`drop ${kind} `)) -
        order.findIndex((kind) => b.startsWith(`drop ${kind} `)),
    );
    for (const drop of ranked) await admin.execute(raw(drop));
  });
});
