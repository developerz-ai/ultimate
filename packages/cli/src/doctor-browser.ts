// `x doctor`'s browser report: which Chrome the e2e driver would launch on this machine, or that
// there is none and the command that installs one. A WARNING only where `x.verify.json` requires
// `e2e` — the case `x verify` reds (`judgeE2eBrowser`) — so an app that upgrades keeps its verdict.

import { findChrome } from '@ultimat3/scraping/cdp';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { browserInstallCommand, e2eBrowserMissingFinding } from './verify-e2e';
import { floorRequires, readVerifyFloor } from './verify-floor';

type Env = Readonly<Record<string, string | undefined>>;

export interface BrowserFact {
  /** The binary `findChrome` answered, or `undefined` when this machine has none it can start. */
  readonly path: string | undefined;
  /** Whether `x.verify.json` names `e2e`, which turns an absent browser into a red gate. */
  readonly required: boolean;
  /** The finding an absent browser is, pre-rendered for this platform and environment. */
  readonly missing: Finding;
  /** The install command for this platform, for the report line. */
  readonly install: string;
}

/** The I/O half. `undefined` outside an app: there is no floor and no e2e suite to report on. */
export async function browserProbe(
  root: string | undefined,
  env: Env = Bun.env,
  platform: string = process.platform,
): Promise<BrowserFact | undefined> {
  if (root === undefined) return undefined;
  return {
    path: await findChrome(env, platform),
    required: floorRequires(await readVerifyFloor(root), 'e2e'),
    missing: e2eBrowserMissingFinding(env, platform),
    install: browserInstallCommand(platform),
  };
}

/** The warning `x doctor` lists beside its verdict: only a REQUIRED step with no browser. */
export const browserWarnings = (fact: BrowserFact | undefined): readonly Finding[] =>
  fact !== undefined && fact.path === undefined && fact.required ? [fact.missing] : [];

/** `data.browser` and one line, on a result `x doctor` already decided: `ok` and findings stay. */
export function withBrowserReport(
  result: CommandResult,
  fact: BrowserFact | undefined,
): CommandResult {
  if (fact === undefined) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const browser: JsonValue = { path: fact.path ?? null, e2eRequired: fact.required };
  const line =
    fact.path === undefined
      ? msg('cli.doctor.browserMissing', { install: fact.install })
      : msg('cli.doctor.browserFound', { path: fact.path });
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), browser },
    lines: [...(result.lines ?? []), line],
  };
}
