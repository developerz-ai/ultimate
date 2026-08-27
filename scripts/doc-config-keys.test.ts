// The rule that a documented `app.config.ts` key exists, and — more of the work — the two ways it
// must stay QUIET: a property of a runtime object that shares a section's name, and a page whose
// whole job is to record that the key was deleted.

import { describe, expect, test } from 'bun:test';
import { configDeclaration, configLeaves } from './config-readers';
import {
  configCitations,
  configKeyFindingFor,
  isKnownKey,
  staleAllowanceFindingFor,
  unknownConfigKeys,
} from './doc-config-keys';
import { DOC_CONFIG_KEY_ALLOWANCES, DOC_CONFIG_PINS_FILE } from './lib/doc-config-key-pins';
import { repoRoot } from './lib/run';

const leaves = configLeaves(await configDeclaration(repoRoot()));

const cited = (markdown: string): readonly string[] =>
  configCitations('wiki/Page.md', markdown, leaves)
    .filter((citation) => !isKnownKey(citation.cited, leaves))
    .map((citation) => citation.cited);

describe('unit · a documented app.config.ts key must exist', () => {
  test('the worked example of axiom 4, in the page that defines axiom 4', () => {
    expect(
      cited("| `this is not supported` | `set jobs.driver = 'pg' in app.config.ts` |"),
    ).toEqual(['jobs.driver']);
    expect(cited(`  fix: 'set jobs.driver = "pg" in app.config.ts',`)).toEqual(['jobs.driver']);
  });

  test('a key that DOES exist is silent, and so is a section prefix of one', () => {
    expect(cited('set `cache.tiers` in app.config.ts')).toEqual([]);
    expect(cited('set `auth.signInPath` in app.config.ts')).toEqual([]);
    // `ai.mcp` is not a leaf; it is the section two leaves sit in, and naming it is legitimate.
    expect(cited('configure `ai.mcp` in app.config.ts')).toEqual([]);
  });
});

describe('unit · what it must stay quiet about', () => {
  test('a runtime property that shares a section name is not a config key', () => {
    // Each of these is a real line of `wiki/Error-Codes.md`; none names app.config.ts, so none is
    // anchored — which is the only reason the rule can afford to be this cheap.
    expect(cited('`authenticate(auth, readSessionCookie(request, auth.sessions.policy))`')).toEqual(
      [],
    );
    expect(cited("clear this one bucket: `auth.limiter.recordSuccess('<key>')`")).toEqual([]);
    expect(cited('point `pwa.icon` at it')).toEqual([]);
  });

  test('a file path inside a link is not a key, even when it starts with a section name', () => {
    const link = 'the rest is `defineConfig()`, see [auth.ts](https://x/packages/auth/src/auth.ts)';
    expect(cited(link)).toEqual([]);
  });

  test('a page recording that the key was DELETED is the page doing its job', () => {
    for (const line of [
      '`realtime.heartbeatMs` in `app.config.ts` was read by nothing and is **deleted**',
      '**There is no `jobs.driver`** — setting it in `app.config.ts` never selected a driver',
      '**`realtime.limits.*` and `realtime.drain.*` are not `app.config.ts` fields**',
      '| ~~`ai.modelEnv`~~ | **Deleted in 8.0.0** — it was an `app.config.ts` key |',
      "**`app.config.ts`'s `database.poolSize` is validated and never read by the client**",
      '**Not** an `app.config.ts` key — nothing reads config at that seam, so `database.jitPreload`',
    ]) {
      expect(cited(line), line).toEqual([]);
    }
  });

  test('and the negation test is narrow enough to leave the real finding alone', () => {
    // "this is not supported" carries the word `not`; a broad negation test eats the one case the
    // whole rule exists for, which is why `NEGATED` is anchored to phrases.
    expect(cited('| `this is not supported` | `set jobs.driver in app.config.ts` |')).toEqual([
      'jobs.driver',
    ]);
  });
});

describe('unit · this tree', () => {
  /**
   * Zero, and it must stay zero. This check landed reporting five: three were the `jobs.driver`
   * worked example the audit predicted, and two it had not — `X_PWA_SYNC_INCOMPLETE`'s Fix cell
   * sent a reader to `pwa.backgroundSync.retry.maxAttempts` when `PwaConfig.backgroundSync` is a
   * `boolean`, and `Troubleshooting.md` named `realtime.url` where the field is `realtime.urlEnv`.
   * All five are fixed. Asserting the CURRENT five would have been a test that pins the defect —
   * it goes green only while they are unfixed, and reds the moment someone repairs one.
   */
  test('this tree tells no reader to set a config key that does not exist', async () => {
    expect((await unknownConfigKeys(repoRoot())).unknown).toEqual([]);
  });

  /**
   * The allowance list's own hygiene: every recorded exception still matches a citation on the page
   * it names, so a row cannot outlive the defect it records.
   *
   * The list is EMPTY as of 12.0.0 and that is the goal state, not a gap in the test — the four
   * `http.*` rows recorded one defect (`AppConfig` declared no `http` member) and 12.0.0 closed it
   * with `configureHttp()`. So this may not assert a non-zero length: the assertion that carries the
   * weight is `staleAllowances`, which is what refuses a row nothing earns, at any list size.
   */
  test('every recorded exception is still earned by the page it names', async () => {
    expect((await unknownConfigKeys(repoRoot())).staleAllowances).toEqual([]);
    for (const one of DOC_CONFIG_KEY_ALLOWANCES) {
      expect(one.why.length).toBeGreaterThan(40);
    }
  });

  /** An entry matching nothing is a finding, not slack — the rule `DOC_COMMAND_ALLOWANCES` runs. */
  test('an allowance no page earns is reported against the pins file', async () => {
    const found = await unknownConfigKeys(repoRoot(), [
      { path: 'wiki/Nowhere.md', cites: 'made.up', why: 'x' },
    ]);
    expect(found.staleAllowances.map((one) => one.cites)).toEqual(['made.up']);
    const finding = staleAllowanceFindingFor(found.staleAllowances[0] as never);
    expect(finding.code).toBe('X_DOC_CONFIG_ALLOWANCE_STALE');
    expect(finding.at).toBe(DOC_CONFIG_PINS_FILE);
  });

  /**
   * The gap the section-anchored token could not see: `sections.join('|')` only ever matches a
   * section that EXISTS, so an instruction naming a section `AppConfig` has never declared matched
   * nothing and `isKnownKey` was never asked. Measured on this tree the day it landed: four
   * citations of `http.*`, which is why `DOC_CONFIG_KEY_ALLOWANCES` has four rows.
   */
  test('an unknown top-level SECTION is reported, not passed over', () => {
    const cited = configCitations(
      'wiki/Made-Up.md',
      ['set `billing.currency` in `app.config.ts` to change the ledger'].join('\n'),
      leaves,
    );
    expect(cited.map((one) => one.cited)).toEqual(['billing.currency']);
  });

  /** Both matchers see a citation whose section does exist; two identical findings are one defect. */
  test('a known section matched by both matchers is reported once', () => {
    expect(
      configCitations('wiki/Made-Up.md', 'set `jobs.driver` in `app.config.ts`', leaves).length,
    ).toBe(1);
  });

  /** The failure path, on a fixture, so the assertion above cannot pass by the scan being broken. */
  test('a page naming a key AppConfig does not declare is reported with its line and its fix', () => {
    const cited = configCitations(
      'wiki/Made-Up.md',
      ['# x', '', 'set `jobs.driver` in `app.config.ts` to change the queue', ''].join('\n'),
      leaves,
    );
    expect(cited.map((one) => `${one.path}:${String(one.line)} ${one.cited}`)).toEqual([
      'wiki/Made-Up.md:3 jobs.driver',
    ]);
    const finding = configKeyFindingFor(cited[0] as never);
    expect(finding.code).toBe('X_DOC_CONFIG_KEY_UNKNOWN');
    expect(finding.fix).toContain('bun run scripts/config-readers.ts --json');
  });

  test('and the scan is not vacuous — the anchored lines it reads are many', () => {
    expect(configCitations('wiki/Page.md', '', leaves)).toEqual([]);
    expect(leaves.length).toBeGreaterThan(20);
  });
});
