/**
 * What the acceptance suite reads out of a page, as in-page expressions — one spelling of "a post's
 * like count" and "its Like button" for every file, so a markup change is one edit here. They read
 * the RENDERED page, never a store: a store that updated and a screen that did not is the defect
 * under test. LOCALE-INDEPENDENT by construction: every count the app renders carries its value as
 * `data-like-count` beside `data-post="<id>"`, and every Like button `data-like-button="<id>"`, so
 * nothing here reads words — mara reads "0 me gusta", and an English pattern found no count at all.
 */

import type { E2eSession, E2eTab } from '@ultimat3/cli';
import { ISLAND_FAILED_ATTRIBUTE, ISLAND_MOUNTED_ATTRIBUTE } from '@ultimat3/render';
import { fail } from './postly';

const countsSelector = (postId: string): string =>
  JSON.stringify(`[data-like-count][data-post="${postId}"]`);

/** Every like count the page shows for this post — the feed row, the post's control, its badge. */
export const likeCounts = (postId: string): string =>
  `[...document.querySelectorAll(${countsSelector(postId)})].map((el) => Number(el.dataset.likeCount))`;

/** The first like count shown for this post, or `null` when none is on the page. */
export const likeCount = (postId: string): string =>
  `(() => { const el = document.querySelector(${countsSelector(postId)}); return el ? Number(el.dataset.likeCount) : null; })()`;

/** True once the post shows at least one count and EVERY count it shows is `count`. */
export const everyCount = (postId: string, count: number): string =>
  `(() => { const shown = ${likeCounts(postId)}; return shown.length > 0 && shown.every((n) => n === ${String(count)}); })()`;

const clickLike = (postId: string): string => `(() => {
  const button = document.querySelector(${JSON.stringify(`[data-like-button="${postId}"]`)});
  if (!button) return false;
  button.click();
  return true;
})()`;

/**
 * Every hydrating island has run its `mount` — the runtime stamps the mounted attribute once it
 * has. The server's markup already carries a Like button, so a click before this lands on a button
 * with no handler and the like silently never happens. A failed mount answers its reason as text
 * (truthy, so the wait ends at once) and `like` turns that into the test's verdict; the page itself
 * throws nothing.
 */
const islandsMounted = `(() => {
  const islands = [...document.querySelectorAll('[data-x-island]:not([data-x-hydrate="never"])')];
  const failed = islands.find((el) => el.hasAttribute('${ISLAND_FAILED_ATTRIBUTE}'));
  if (failed) return 'island ' + failed.getAttribute('data-x-island') + ' failed to mount: ' + failed.getAttribute('${ISLAND_FAILED_ATTRIBUTE}');
  return islands.length > 0 && islands.every((el) => el.hasAttribute('${ISLAND_MOUNTED_ATTRIBUTE}'));
})()`;

/** A page value as a number — the port answers `unknown`, and a test reads it, never casts it. */
export async function readNumber(tab: E2eTab, expression: string): Promise<number> {
  const value = await tab.evaluate(expression);
  return typeof value === 'number'
    ? value
    : fail(`${expression} answered ${JSON.stringify(value)}, not a number`);
}

export async function readNumbers(
  tab: E2eTab,
  expression: string,
): Promise<readonly (number | null)[]> {
  const value = await tab.evaluate(expression);
  if (!Array.isArray(value)) return fail(`${expression} answered no list`);
  return value.map((one: unknown) => (typeof one === 'number' ? one : null));
}

export async function readFlag(tab: E2eTab, expression: string): Promise<boolean> {
  return (await tab.evaluate(`Boolean(${expression})`)) === true;
}

/** Click this post's Like once the page's islands are live — never on the server's inert markup. */
export async function like(tab: E2eTab, postId: string): Promise<void> {
  await tab.waitFor(islandsMounted, "the page's islands to mount");
  const mounted = await tab.evaluate(islandsMounted);
  if (typeof mounted === 'string') fail(mounted);
  if (!(await readFlag(tab, clickLike(postId))))
    fail(`no [data-like-button="${postId}"] on the page`);
}

/** `/_x/sync` sockets the browser opened to THIS app — the run's browser also serves other suites. */
export const syncSockets = (session: E2eSession, base: string): number =>
  session.sockets().filter((url) => url.includes(`${new URL(base).host}/_x/sync`)).length;

/** Requests to THIS app sent after `mark` (`session.requests().length` taken before the act). */
export const requestsSince = (
  session: E2eSession,
  base: string,
  mark: number,
  match: RegExp,
): readonly string[] =>
  session
    .requests()
    .slice(mark)
    .filter((line) => line.includes(new URL(base).host) && match.test(line));

/** Polls the harness itself (not a page) until `check` holds, or fails naming `what`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  fail(`waited ${timeoutMs}ms for ${what}`);
}

/**
 * Every row of every IndexedDB object store this origin holds, as JSON text — what "no record of
 * the previous principal on disk" is checked against. Names alone prove nothing: the client keeps
 * ONE database and scopes rows inside it, so a principal's records can outlive every name change.
 */
export const indexedDbDump = `(async () => {
  const out = [];
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    for (const store of db.objectStoreNames) {
      const rows = await new Promise((resolve) => {
        const read = db.transaction(store).objectStore(store).getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => resolve([]);
      });
      out.push(JSON.stringify(rows));
    }
    db.close();
  }
  return out.join('\\n');
})()`;

export async function readText(tab: E2eTab, expression: string): Promise<string> {
  const value = await tab.evaluate(expression);
  return typeof value === 'string' ? value : fail(`${expression.slice(0, 60)}… answered no text`);
}
