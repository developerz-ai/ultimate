#!/usr/bin/env bun
// `llms.txt`'s two derived lists, generated: the packages (from `listWorkspaces` and each
// package's own `description`) and the wiki pages (in `wiki/_Sidebar.md`'s order, summarised by
// `wiki/Home.md`'s tables). The file said "generated from list-workspaces" and was hand-written —
// `@ultimat3/notify` shipped and never appeared in it. Everything outside the two marked blocks
// stays prose; `--write` rewrites the blocks, and the gate's `manifest` step refuses drift.
//
//   bun run llms-txt [--write] [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces } from './lib/workspaces';

export const LLMS_TXT = 'llms.txt';
const RAW = 'https://raw.githubusercontent.com/developerz-ai/ultimate/main';
const FIX = 'bun run llms-txt --write';

export const BLOCKS = ['packages', 'wiki'] as const;
export type BlockName = (typeof BLOCKS)[number];

const open = (name: BlockName): string => `<!-- generated: ${name} — ${FIX} -->`;
const CLOSE = '<!-- end generated -->';
// Home is not in the sidebar's list and summarises every other page; it cannot summarise itself.
const HOME_SUMMARY = 'the full wiki index, with a reading path per audience';

export interface PackageLine {
  readonly name: string;
  readonly dir: string;
  readonly tier: number;
  readonly description: string;
}

export const packageLine = (pkg: PackageLine): string => {
  const base = `${RAW}/packages/${pkg.dir}`;
  const text = pkg.description.replace(/\.?\s*$/, '.');
  return `- [${pkg.name}](${base}/README.md): tier ${pkg.tier} — ${text} Boundary and deps: [CLAUDE.md](${base}/CLAUDE.md).`;
};

/** `[Title](Page)` links in the sidebar, in order: the reading order the wiki itself chose. */
export function sidebarPages(sidebar: string): readonly { title: string; page: string }[] {
  return [...sidebar.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map((match) => ({
    title: match[1] ?? '',
    page: match[2] ?? '',
  }));
}

/** `| [Title](Page) | summary |` rows on Home.md: the one place a page is summarised. */
export function homeSummaries(home: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const match of home.matchAll(/^\| \[[^\]]+\]\(([^)]+)\) \| (.+?) \|\s*$/gm)) {
    if (match[1] !== undefined && match[2] !== undefined) out.set(match[1], match[2]);
  }
  return out;
}

export function wikiLines(sidebar: string, home: string): readonly string[] {
  const summaries = homeSummaries(home);
  const pages = [{ title: 'Home', page: 'Home' }, ...sidebarPages(sidebar)];
  const seen = new Set<string>();
  return pages.flatMap(({ title, page }) => {
    if (seen.has(page)) return [];
    seen.add(page);
    const summary = page === 'Home' ? HOME_SUMMARY : summaries.get(page);
    const link = `- [${title}](${RAW}/wiki/${page}.md)`;
    return [summary === undefined ? `${link}.` : `${link}: ${summary}.`];
  });
}

/** The text with each marked block replaced; `undefined` names a block whose markers are gone. */
export function fillBlocks(
  text: string,
  blocks: Readonly<Record<BlockName, readonly string[]>>,
): { readonly text: string; readonly missing: readonly BlockName[] } {
  let out = text;
  const missing: BlockName[] = [];
  for (const name of BLOCKS) {
    const start = out.indexOf(open(name));
    const end = start === -1 ? -1 : out.indexOf(CLOSE, start);
    if (end === -1) {
      missing.push(name);
      continue;
    }
    const body = [open(name), ...blocks[name], CLOSE].join('\n');
    out = out.slice(0, start) + body + out.slice(end + CLOSE.length);
  }
  return { text: out, missing };
}

/** What `--write` would change, one finding per entry added or removed. */
export function llmsDrift(
  current: string,
  wanted: string,
  missing: readonly BlockName[],
): Finding[] {
  const findings: Finding[] = missing.map((name) => ({
    code: 'X_LLMS_TXT_DRIFT',
    cause: `${LLMS_TXT} has no "${open(name)}" … "${CLOSE}" block, so the ${name} list is not generated`,
    fix: `add the two marker lines around the ${name} list in ${LLMS_TXT}, then ${FIX}`,
    at: LLMS_TXT,
  }));
  const had = new Set(current.split('\n'));
  const wants = new Set(wanted.split('\n'));
  for (const line of wants) {
    if (!had.has(line)) findings.push(entry(`is missing ${line}`));
  }
  for (const line of had) {
    if (!wants.has(line)) findings.push(entry(`carries an entry nothing generates: ${line}`));
  }
  return findings;
}

const entry = (what: string): Finding => ({
  code: 'X_LLMS_TXT_DRIFT',
  cause: `${LLMS_TXT} ${what.slice(0, 240)}`,
  fix: FIX,
  at: LLMS_TXT,
});

export async function renderLlmsTxt(root: string) {
  const current = await Bun.file(`${root}/${LLMS_TXT}`).text();
  const packages: string[] = [];
  for (const workspace of await listWorkspaces(root)) {
    if (workspace.private) continue;
    const raw: unknown = await Bun.file(`${workspace.path}/package.json`).json();
    const description =
      typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'description') : '';
    packages.push(
      packageLine({
        ...workspace,
        description: typeof description === 'string' ? description : '',
      }),
    );
  }
  const wiki = wikiLines(
    await Bun.file(`${root}/wiki/_Sidebar.md`).text(),
    await Bun.file(`${root}/wiki/Home.md`).text(),
  );
  const filled = fillBlocks(current, { packages, wiki });
  return { current, ...filled, findings: llmsDrift(current, filled.text, filled.missing) };
}

/**
 * The gate's half: every drift `--write` would repair, as findings. A root with no `llms.txt` is
 * not this repository — a host-check fixture — and is not judged; `llms-txt.test.ts` holds the
 * real file to existing, so an absent one here cannot be a silent pass.
 */
export const llmsTxtFindings = async (root: string): Promise<readonly Finding[]> =>
  (await Bun.file(`${root}/${LLMS_TXT}`).exists()) ? (await renderLlmsTxt(root)).findings : [];

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const rendered = await renderLlmsTxt(root);
  const write = args.flags.get('write') === true && rendered.missing.length === 0;
  if (write) await Bun.write(`${root}/${LLMS_TXT}`, rendered.text);
  const findings = write ? [] : rendered.findings;
  report(
    {
      ok: findings.length === 0,
      script: 'llms-txt',
      summary: write
        ? `${LLMS_TXT} regenerated`
        : findings.length === 0
          ? `${LLMS_TXT} matches what it is generated from`
          : `${findings.length} ${LLMS_TXT} line(s) differ from what it is generated from`,
      findings,
    },
    args.json,
  );
}
