// The one projection four surfaces read. What this file pins is that they read the SAME one: the
// code, the cause and the `fix:` a `/_x` row shows are the bytes `x dev` prints, the bytes the
// overlay renders and the bytes the log line carries — and every one of them comes from
// `@ultimat3/entity`, never from a sentence composed here.
//
// The relation derivation behind a `preload` fix is `packages/entity/src/n-plus-one.test.ts`'s and
// is not re-proved here: this file must not register entities, because the registry is
// process-global and a sibling test in this package clears it.

import { afterEach, describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL, logger } from '@ultimat3/core';
import type { StatementAttribution } from '@ultimat3/db';
import type { RepeatedStatement } from './dev-n-plus-one';
import { renderFinding } from './output';
import { loopFacts, loopFinding, loopNotice, warnLoop } from './statement-loop';

const SELECT_ONE = 'select "id" from "members" where "id" = $1';

const repeat = (over: Partial<RepeatedStatement> = {}): RepeatedStatement => ({
  fingerprint: SELECT_ONE,
  kind: 'read',
  attribution: undefined,
  sample: SELECT_ONE,
  count: 50,
  requestId: 'req_1',
  traceId: 'trace_1',
  ...over,
});

const FIND_BY_ID: StatementAttribution = { entity: 'members', op: 'findById' };

const lines: string[] = [];
const original = logger.warn;

afterEach(() => {
  logger.warn = original;
  lines.length = 0;
});

/** Capture `logger.warn` the way `dev-roles.test.ts` does — the one seam a log line is testable at. */
function capture(): void {
  logger.warn = (line: string): void => {
    lines.push(line);
  };
}

describe('unit · a verdict becomes the error @ultimat3/entity owns', () => {
  test('a read loop is X_N_PLUS_ONE_QUERY, carrying the count as it stands now', () => {
    const facts = loopFacts(repeat({ count: 50 }));

    expect(facts.code).toBe('X_N_PLUS_ONE_QUERY');
    // Not `ran 5 times` because that is where the threshold sat: a surface asks, and the answer is
    // the loop as it actually ran.
    expect(facts.cause).toContain('ran 50 times');
    // `loopFacts` copies the error's own `docs`, so this pins @ultimat3/entity's link THROUGH the
    // projection — against the CONSTANT, never a literal, which is how the dead per-code host
    // survived every suite in the tree while each one asserted its own hand-copied spelling of it.
    expect(facts.docs).toBe(ERROR_DOCS_URL);
  });

  test('an attributed read names the batched call on the entity that repeated', () => {
    const facts = loopFacts(repeat({ fingerprint: 'members.findById', attribution: FIND_BY_ID }));

    expect(facts.subject).toBe('members.findById');
    expect(facts.fix).toContain("db.members.andWhere('id', 'in', ids).all()");
  });

  test('a write loop is X_N_PLUS_ONE_WRITE, and its fix names the bulk call', () => {
    const facts = loopFacts(
      repeat({
        kind: 'write',
        fingerprint: 'posts.delete',
        attribution: { entity: 'posts', op: 'delete' },
        count: 12,
      }),
    );

    expect(facts.code).toBe('X_N_PLUS_ONE_WRITE');
    expect(facts.cause).toContain('posts.delete ran 12 times');
    expect(facts.fix).toContain('db.posts.deleteWhere(filter)');
  });

  test('hand-written SQL keeps its own text as the subject and gets the statement fix', () => {
    const facts = loopFacts(repeat());

    expect(facts.subject).toBe(SELECT_ONE);
    // Nothing to name a chain with, so the fix is the shape of the statement plus the one way to
    // declare the loop deliberate — never a `preload` on an entity this loop never mentioned.
    expect(facts.fix).toContain('expectedQueryLoop(');
    expect(facts.fix).not.toContain('preload(');
  });

  test('the sample and the request id ride along, so a verdict joins its trace and its log line', () => {
    const facts = loopFacts(repeat({ requestId: 'req_9', sample: 'select 1' }));

    expect(facts.requestId).toBe('req_9');
    expect(facts.sample).toBe('select 1');
    expect(facts.count).toBe(50);
  });
});

describe('unit · one verdict, projected onto each surface', () => {
  test('the x dev finding renders the 3-line contract, located by request', () => {
    const facts = loopFacts(repeat({ requestId: 'req_4' }));
    const finding = loopFinding(facts);

    expect(finding.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(finding.at).toBe('req_4');
    const rendered = renderFinding(finding).split('\n');
    expect(rendered[0]).toBe('X_N_PLUS_ONE_QUERY (req_4)');
    expect(rendered[1]).toBe(`  cause: ${facts.cause}`);
    expect(rendered[2]).toBe(`  fix:   ${facts.fix}`);
  });

  test('the overlay notice carries the same three strings, and no locator', () => {
    const facts = loopFacts(repeat());
    const notice = loopNotice(facts);

    // `StatementLoopFact.docs` is `string | null` and `OverlayNotice.docs` is omitted-or-string, so
    // the null case cannot be compared as a key — and `nPlusOne` always resolves one, which is what
    // this asserts before reading it. The absent case is the test below.
    const docs = facts.docs;
    if (docs === null) expect.unreachable('nPlusOne resolved no docs link');
    expect(notice).toEqual({
      code: facts.code,
      cause: facts.cause,
      fix: facts.fix,
      // The projection's own field, not the constant: this test asks whether the overlay carries
      // the SAME strings the finding does. Where the link itself comes from is pinned once, above.
      docs,
    });
    expect(Object.hasOwn(notice, 'at')).toBe(false);
  });

  test('a verdict with no doc link omits the key rather than passing undefined', () => {
    // `exactOptionalPropertyTypes`: a producer passing `docs: undefined` does not compile against
    // the overlay, and a finding carrying it would render an empty `docs:` line.
    const withoutDocs = { ...loopFacts(repeat()), docs: null };

    expect(Object.hasOwn(loopNotice(withoutDocs), 'docs')).toBe(false);
    expect(Object.hasOwn(loopFinding(withoutDocs), 'docs')).toBe(false);
  });

  test('the log line is one record holding the code, the cause and the fix', () => {
    const facts = loopFacts(repeat({ attribution: FIND_BY_ID, fingerprint: 'members.findById' }));
    capture();
    warnLoop(facts);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${facts.code}: ${facts.cause} — fix: ${facts.fix}`);
  });
});
