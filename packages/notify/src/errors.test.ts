import { describe, expect, test } from 'bun:test';
// why: this suite reads its OWN package's source to hold a rule no type can — that every `fix:`
// resolves as written, and that a comment quoting SQL quotes the SQL that is there. Bun ships no
// native synchronous directory walk; `Bun.Glob().scanSync` exists but still needs `Bun.file().text()`
// per entry, which is async and buys nothing here. Delete both the day Bun has a sync read.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { declaredErrorRetry, describeErrorCode } from '@ultimat3/core';
import { nextRetryForError } from '@ultimat3/jobs';
import {
  NOTIFY_ERROR_CODES,
  NOTIFY_ERROR_TITLES,
  NotifyDeliveryFailedError,
  NotifyFanoutTooWideError,
  NotifyStoreMissingError,
} from './errors';

const SRC = import.meta.dir;

/** Every `fix:` string literal in a source file, single- or double-quoted or a template. */
const FIX_LINE = /fix:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;

/**
 * `x <command> <subcommand> ${…}` — an interpolated value sitting where a POSITIONAL goes.
 *
 * A flag's value is deliberately not matched: `--filter ${name}` is a substring match and
 * resolves. A positional is an id the command looks up, and a name this framework happens to know
 * is not one.
 */
const INTERPOLATED_POSITIONAL = /\bx(?: [a-z][a-z-]*){1,3} \$\{/;

describe('unit · @ultimat3/notify errors', () => {
  test('every declared code is namespaced and screaming snake case', () => {
    for (const code of NOTIFY_ERROR_CODES) {
      expect(code).toMatch(/^X_NOTIFY_[A-Z0-9_]+$/);
    }
  });

  test('every code is registered with a title, so `x` can render it', () => {
    for (const code of NOTIFY_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(NOTIFY_ERROR_TITLES[code]);
    }
  });

  test('the fan-out refusal names BOTH numbers and an executable alternative', () => {
    const error = new NotifyFanoutTooWideError({
      notifier: 'post.liked',
      recipients: 900,
      max: 500,
    });
    expect(error).toBeUltimateError('X_NOTIFY_FANOUT_TOO_WIDE');
    expect(error.cause).toContain('900');
    expect(error.cause).toContain('500');
    expect(error.fix).toContain('bulkChannel()');
  });

  test('the store refusal names the install call for the store that is actually missing', () => {
    expect(new NotifyStoreMissingError({ notifier: 'n', store: 'inbox' }).fix).toContain(
      'createMemoryInboxStore()',
    );
    expect(new NotifyStoreMissingError({ notifier: 'n', store: 'digest' }).fix).toContain(
      'createMemoryDigestStore()',
    );
  });

  test('a caught value reaches the cause through renderThrowable, never interpolated', () => {
    // A provider rejection is routinely an object whose `toString` throws, and a template literal
    // on one turns a delivery failure into a crash inside the error constructor.
    const hostile = {
      toString() {
        throw new TypeError('no');
      },
    };
    const error = new NotifyDeliveryFailedError({
      notifier: 'post.liked',
      channel: 'email',
      recipients: 1,
      cause: hostile,
    });
    expect(error).toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');
    expect(error.cause).toContain('email');
  });
});

/**
 * The classification, driven through the function the WORKER actually calls.
 *
 * `nextRetryForError` short-circuits on `terminal` and on nothing else, so an UNCLASSIFIED code
 * falls through to the attempt count and spends the whole policy — and `classifyThrown` reads an
 * unregistered code as unclassified even when its instance carries `terminal`, which is why the
 * registration has to be explicit. This suite asserts the OUTCOME (does the attempt stop?) rather
 * than the table, because the table is not what a dead-lettered job is decided by.
 */
describe('unit · @ultimat3/notify retry classification', () => {
  const policy = { attempts: 5, backoff: 'fixed', delay: 1_000, jitter: false } as const;

  test('a fan-out past the ceiling stops on the attempt it happened', () => {
    // 900 recipients against a 500 ceiling answers 900 against 500 on every attempt. Retrying it
    // four more times is four more audience resolutions and four more dead-letter delays for a
    // number that cannot move.
    const decision = nextRetryForError(
      policy,
      1,
      new NotifyFanoutTooWideError({ notifier: 'digest', recipients: 900, max: 500 }),
    );
    expect(decision.retry).toBe(false);
    expect(decision.deadLetter).toBe(true);
  });

  test('a missing store stops on the attempt it happened, both kinds', () => {
    for (const store of ['inbox', 'digest'] as const) {
      const decision = nextRetryForError(
        policy,
        1,
        new NotifyStoreMissingError({ notifier: 'digest', store }),
      );
      expect(decision.retry).toBe(false);
    }
  });

  test('a channel that threw is RETRYABLE, and that is declared rather than inherited', () => {
    // The one code here a retry can fix: a provider blip, a timeout, a 503. It reads correctly
    // today only because `unclassified` happens to fall through to the attempt count — declaring
    // it is what makes that an answer instead of a coincidence, and what stops the next sweep
    // through this file from making the whole package terminal.
    const decision = nextRetryForError(
      policy,
      1,
      new NotifyDeliveryFailedError({
        notifier: 'digest',
        channel: 'mail',
        recipients: 1,
        cause: new Error('provider timeout'),
      }),
    );
    expect(decision.retry).toBe(true);
    expect(decision.nextAttempt).toBe(2);
  });

  test('every code reachable from a job body is classified, and nothing else is', () => {
    // The audit, kept executable. A code thrown only by `notifier()` at declaration never reaches
    // `classifyThrown` — the worker is not running yet — so classifying it would be a claim
    // nothing reads. A code thrown inside `runFanout` must be classified, or it spends the policy.
    const runtime = [
      'X_NOTIFY_FANOUT_TOO_WIDE',
      'X_NOTIFY_STORE_MISSING',
      'X_NOTIFY_DELIVERY_FAILED',
    ];
    const declarationTime = [
      'X_NOTIFY_CHANNELS_EMPTY',
      'X_NOTIFY_CHANNEL_DUPLICATE',
      'X_NOTIFY_DIGEST_UNSUPPORTED',
    ];
    expect([...runtime, ...declarationTime].sort()).toEqual([...NOTIFY_ERROR_CODES].sort());
    for (const code of runtime) expect(declaredErrorRetry(code)).toBeDefined();
    for (const code of declarationTime) expect(declaredErrorRetry(code)).toBeUndefined();
  });
});

describe('unit · @ultimat3/notify fix lines resolve as written', () => {
  test('the delivery refusal does not hand a notifier NAME to a command that wants a job id', () => {
    // `x jobs show` takes a job id positional and resolves it through `inspectJob`, which answers
    // `X_JOB_UNKNOWN` for anything else. A notifier name is not a job id, so the command this
    // fix printed failed every single time it was run — and a `fix:` that fails is worse than no
    // `fix:`, because the reader spends their trust on it before finding out.
    const fix = new NotifyDeliveryFailedError({
      notifier: 'digest',
      channel: 'mail',
      recipients: 1,
      cause: new Error('boom'),
    }).fix;

    expect(fix).not.toMatch(/x jobs show\s+digest/);
    // The two-step shape the wiki row already documents: list, then show the id you found.
    expect(fix).toContain('x jobs ls');
    expect(fix).toContain('x jobs show <id>');
    // The substantive half survives — the failing step is what the reader is looking for.
    expect(fix).toContain('deliver:mail');
  });

  test('no fix in this package interpolates a value into a command positional', () => {
    // The general rule, applied to the whole package rather than the one instance. `x <cmd> <arg>`
    // where `<arg>` came from the error's own input is the shape that fails: the value is a name
    // this framework knows, and the command wants an id it does not.
    const sources = readdirSync(SRC).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const offenders: string[] = [];
    for (const name of sources) {
      const text = readFileSync(join(SRC, name), 'utf8');
      for (const [, , body] of text.matchAll(FIX_LINE)) {
        if (body !== undefined && INTERPOLATED_POSITIONAL.test(body)) {
          offenders.push(`${name}: ${body}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the rule catches the string that actually shipped', () => {
    // Guards the guard: a regex matching nothing passes the test above forever. The placeholder is
    // CONCATENATED rather than written whole — a literal `$` followed by `{` inside a plain string
    // is what `noTemplateCurlyInString` exists to catch, and this file is the one place that has to
    // spell the shape it is looking for.
    const hole = `$${'{input.notifier}'}`;
    expect(INTERPOLATED_POSITIONAL.test(`x jobs show ${hole} --json — the failing step`)).toBe(
      true,
    );
    expect(INTERPOLATED_POSITIONAL.test('x jobs ls --json   # then: x jobs show <id> --json')).toBe(
      false,
    );
    // A FLAG's value is not a positional: `--filter <name>` is a substring match, which resolves.
    expect(INTERPOLATED_POSITIONAL.test(`x test job --filter ${hole}`)).toBe(false);
  });
});

describe('unit · @ultimat3/notify comments match the SQL they describe', () => {
  test('the duplicate refusal quotes the ledger index as it is actually written', () => {
    // The comment said `(notifier, key, recipient, channel)`. The index is
    // `(notifier, key, channel, coalesce(recipient, ''))`. The COALESCE is the load-bearing half:
    // NULLs are distinct in a plain unique index, so a bulk claim with a null recipient would be
    // claimable without bound — a comment that omits it invites exactly the simplification that
    // reintroduces that.
    const sql = readFileSync(join(SRC, 'ledger-pg.ts'), 'utf8');
    const index = /on x_notify_deliveries \(([^)]*\([^)]*\)[^)]*|[^)]*)\)/.exec(sql)?.[1]?.trim();

    expect(index).toBe("notifier, key, channel, coalesce(recipient, '')");
    // `on conflict` must infer the SAME index expression or Postgres cannot use it at all.
    expect(sql).toContain(`on conflict (${index})`);
    // FOUR spellings, and the wrong one shipped in three of them — the audit read the declaration
    // and found one. The package docs are the public half: `@ultimat3/notify` reaches npm for the
    // first time in this release, so its README is read by people who cannot ask what it meant.
    for (const path of ['errors.ts', '../CLAUDE.md', '../README.md']) {
      const text = readFileSync(join(SRC, path), 'utf8');
      expect(text).toContain(`(${index})`);
      expect(text).not.toContain('(notifier, key, recipient, channel)');
    }
  });
});
