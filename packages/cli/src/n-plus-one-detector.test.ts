// The detector end to end, against real repository calls rather than hand-built `StatementEvent`s
// — `dev-n-plus-one.test.ts` and `statement-loop.test.ts` prove the ledger and the fix-line
// projection against synthetic events; this file proves the loop the ledger exists for: a naive
// `posts` → `authors` read, its `preload('author')` fix, `expectedQueryLoop`'s suppression, and
// the write-loop sibling — all through `@ultimat3/db`'s actual observer funnel.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import {
  createPgliteClient,
  expectedQueryLoop,
  type PgliteDriver,
  type PgliteResult,
  setStatementObserver,
} from '@ultimat3/db';
import {
  database,
  entity,
  N_PLUS_ONE_THRESHOLD,
  postgresDriver,
  postgresRepo,
  text,
  uuid,
} from '@ultimat3/entity';
import { createStatementLedger, type StatementLedger } from './dev-n-plus-one';
import { loopFacts } from './statement-loop';

const authors = entity('n1cli_authors', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const posts = entity('n1cli_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id),
    title: text({ max: 120 }),
  },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const AUTHOR = idAt(1);

const authorRow = (id: string = AUTHOR): Record<string, unknown> => ({ id, name: 'Ada Author' });
const postRow = (id: string, authorId: string): Record<string, unknown> => ({
  id,
  author_id: authorId,
  title: `Post ${id.slice(-2)}`,
});

/** One page, all by the one author — the loop this whole file is about. */
const aPageOfPosts = (): readonly Record<string, unknown>[] =>
  Array.from({ length: N_PLUS_ONE_THRESHOLD }, (_, index) => postRow(idAt(10 + index), AUTHOR));

interface StubResponse {
  readonly rows?: readonly Record<string, unknown>[];
  readonly affectedRows?: number;
}

/**
 * A `PgliteDriver` that answers by matching the statement text, the way `createRecordingClient`
 * does — but injected as PGlite's own driver rather than standing in for `DbClient` directly, so
 * every statement still passes through `@ultimat3/db`'s real observer funnel
 * (`createRecordingClient` implements `DbClient` on its own and never reaches `runOn`/`statement()`,
 * which is why the ledger never sees anything sent through it).
 */
function stubbedDriver(): PgliteDriver & { on(match: RegExp, response: StubResponse): void } {
  const stubs: { match: RegExp; response: StubResponse }[] = [];
  return {
    on(match, response): void {
      stubs.push({ match, response });
    },
    async query(text): Promise<PgliteResult> {
      for (let index = stubs.length - 1; index >= 0; index -= 1) {
        const stub = stubs[index];
        if (stub !== undefined && stub.match.test(text)) {
          return { rows: stub.response.rows ?? [], affectedRows: stub.response.affectedRows };
        }
      }
      return { rows: [] };
    },
    async close(): Promise<void> {},
  };
}

let ledger: StatementLedger;

beforeEach(() => {
  ledger = createStatementLedger();
  setStatementObserver(ledger.observer);
});

afterEach(() => {
  setStatementObserver(undefined);
});

const inRequest = <T>(work: () => Promise<T>): Promise<T> => runWithContext(createContext(), work);

// `n1` is this codebase's own shorthand for the pattern (`packages/entity/src/n-plus-one.test.ts`'s
// `n1_members`/`n1_posts` fixtures) — spelled that way here too so `-t 'n+1'` (a regex, not a
// literal — `+` is a quantifier) actually selects this file's tests.
describe('detector · a real n1 loop over posts and their authors', () => {
  test('a naive per-row lookup trips X_N_PLUS_ONE_QUERY with the exact preload line', async () => {
    const driver = stubbedDriver();
    driver.on(/"n1cli_posts"/, { rows: aPageOfPosts() });
    driver.on(/"n1cli_authors"/, { rows: [authorRow()] });
    const client = createPgliteClient({ driver });
    // JIT preload (on by default, `packages/entity/src/jit-preload.ts`) would batch this exact
    // loop into two statements on its own — off here because this test is about the loop the
    // detector exists for, not the one the framework already fixes for free.
    const postRepo = postgresRepo(posts, { client, jitPreload: false });
    const authorRepo = postgresRepo(authors, { client });

    await inRequest(async () => {
      const page = await postRepo.findMany();
      // Sequential, awaiting between rows — the naive shape, and the one no microtask coalescer
      // can see across.
      for (const post of page.rows) {
        await authorRepo.findById(post.authorId);
      }
    });

    expect(ledger.repeats()).toHaveLength(1);
    const [loop] = ledger.repeats();
    if (loop === undefined) return expect.unreachable('the ledger recorded no repeat');
    expect(loop.fingerprint).toBe('n1cli_authors.findById');
    expect(loop.kind).toBe('read');
    expect(loop.count).toBe(N_PLUS_ONE_THRESHOLD);

    const facts = loopFacts(loop);
    expect(facts.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(facts.cause).toBe(
      `n1cli_authors.findById ran ${N_PLUS_ONE_THRESHOLD} times in one request — one read per row`,
    );
    expect(facts.fix).toBe("db.n1cli_posts.preload('author')   # one statement for the whole page");
  });

  test('the preload form of the exact same read stays quiet', async () => {
    const driver = stubbedDriver();
    driver.on(/"n1cli_posts"/, { rows: aPageOfPosts() });
    driver.on(/"n1cli_authors"/, { rows: [authorRow()] });
    const client = createPgliteClient({ driver });
    const db = database({ authors, posts }, { driver: postgresDriver({ client }) });

    const rows = await inRequest(() => db.posts.preload('author').all());

    expect(rows).toHaveLength(N_PLUS_ONE_THRESHOLD);
    // One statement for the page, one more for the whole set of authors — neither shape repeats.
    expect(ledger.repeats()).toEqual([]);
  });

  test('expectedQueryLoop silences the exact same naive loop', async () => {
    const driver = stubbedDriver();
    driver.on(/"n1cli_posts"/, { rows: aPageOfPosts() });
    driver.on(/"n1cli_authors"/, { rows: [authorRow()] });
    const client = createPgliteClient({ driver });
    const postRepo = postgresRepo(posts, { client, jitPreload: false });
    const authorRepo = postgresRepo(authors, { client });

    await inRequest(() =>
      expectedQueryLoop('demonstrating the suppression the detector honors', async () => {
        const page = await postRepo.findMany();
        for (const post of page.rows) {
          await authorRepo.findById(post.authorId);
        }
      }),
    );

    // The statements were still sent — this proves the ledger stayed quiet, not that the loop
    // didn't happen.
    expect(ledger.repeats()).toEqual([]);
  });

  test('a naive per-row delete loop trips X_N_PLUS_ONE_WRITE, fixed by deleteWhere', async () => {
    const driver = stubbedDriver();
    driver.on(/delete from "n1cli_posts"/, { affectedRows: 1 });
    const client = createPgliteClient({ driver });
    const postRepo = postgresRepo(posts, { client });

    await inRequest(async () => {
      for (let index = 0; index < N_PLUS_ONE_THRESHOLD; index += 1) {
        await postRepo.delete(idAt(30 + index));
      }
    });

    expect(ledger.repeats()).toHaveLength(1);
    const [loop] = ledger.repeats();
    if (loop === undefined) return expect.unreachable('the ledger recorded no repeat');
    expect(loop.kind).toBe('write');

    const facts = loopFacts(loop);
    expect(facts.code).toBe('X_N_PLUS_ONE_WRITE');
    expect(facts.cause).toBe(
      `n1cli_posts.delete ran ${N_PLUS_ONE_THRESHOLD} times in one request — one write per row`,
    );
    expect(facts.fix).toBe(
      'db.n1cli_posts.deleteWhere(filter)   # one statement for the whole set',
    );
  });
});
