#!/usr/bin/env bun
// Enforce, as a gate rule, that the dependency graph `docs/architecture/01-package-map.md` DRAWS
// is the dependency graph the manifests declare: every arrow is a dependency the `from` package's
// own `package.json` holds, and every publishable workspace is a node on it.
//
// The gap this closes: eleven arrows — `schema→core`, `ui→render`, `render→query`, `policy→i18n`,
// `cache→time`, `seo→i18n`, `realtime→policy`, `realtime→http`, `action→entity`, `query→entity`,
// `testing→action` — described imports no manifest and no module ever made, `ui` sat in the wrong
// tier subgraph and `scraping` was absent entirely. Corrected by hand, and nothing read the graph
// afterwards, which is axiom 3.
//
// Only inside a ```mermaid fence, and that is load-bearing rather than tidy: the prose ABOVE the
// graph on that same page writes `render --> query` and `ui --> render` as examples of arrows that
// were wrong, so a line scan for `-->` reports the sentence that documents the fix. Markdown's own
// `<!-- … -->` ends in one too.
//
//   bun run scripts/package-map-graph.ts [--json]

// `node:` — Bun has no path-join primitive of its own.
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { tierOf } from './lib/tiers';
import type { PackageJson } from './lib/workspaces';
import { readWorkspaceManifest } from './lib/workspaces';

const SCRIPT = 'package-map-graph';

/** The manifests this rule reads — the one a finding names when none of them could be read. */
const PACKAGES_GLOB = 'packages/*/package.json';

/** The one page that draws the graph, and the file every finding points at. */
export const PACKAGE_MAP = 'docs/architecture/01-package-map.md';

export interface NumberedLine {
  readonly line: number;
  readonly text: string;
}

// Up to three leading spaces is still a fence in CommonMark; four makes it an indented code block.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every line inside a TOP-LEVEL ```mermaid block. A fence closes only on the same character, at
 * least as long, with nothing after it — which is what makes a ```mermaid nested inside a wider
 * ````markdown fence content rather than a second opener.
 */
export function mermaidLines(markdown: string): {
  readonly blocks: number;
  readonly lines: readonly NumberedLine[];
} {
  const lines: NumberedLine[] = [];
  let blocks = 0;
  let open: { readonly marker: string; readonly mermaid: boolean } | undefined;
  const source = markdown.split('\n');
  for (let index = 0; index < source.length; index += 1) {
    const text = source[index] ?? '';
    const fence = FENCE.exec(text);
    const marker = fence?.[1] ?? '';
    const info = (fence?.[2] ?? '').trim();
    if (open === undefined) {
      if (fence === null) continue;
      const mermaid = info === 'mermaid';
      if (mermaid) blocks += 1;
      open = { marker, mermaid };
      continue;
    }
    if (
      fence !== null &&
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      info === ''
    ) {
      open = undefined;
      continue;
    }
    if (open.mermaid) lines.push({ line: index + 1, text });
  }
  return { blocks, lines };
}

/**
 * A mermaid line with every place a `-->` can sit WITHOUT being an edge removed: a `%%` comment,
 * a quoted label, a bracketed node shape, a `|edge label|`.
 */
export const cleanMermaid = (text: string): string =>
  text
    .replace(/%%.*$/, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, '')
    .replace(/\|[^|]*\|/g, ' ')
    .trim();

const EDGE = /^([A-Za-z_][\w.-]*)\s*-->\s*([A-Za-z_][\w.-]*)$/;
/**
 * Every OTHER mermaid link operator, so an edge this rule cannot parse is reported rather than
 * silently absent — a graph check that skips what it does not understand answers a clean page.
 *
 * A RUN of two or more of `-`, `=` and `.`, rather than an enumeration of the operators. Every
 * link in the flowchart grammar carries one — normal `---`/`-->`/`--x`/`<-->`, thick `===`/`==>`,
 * dotted `-.-`/`-..-`/`-...->`, and each of the three with inline text (`-- t -->`, `== t ==>`,
 * `-. t .->`) — and enumerating them let FIVE valid forms fall through to the node scan and vanish:
 * `===`, `-..-`, `-...-`, `-..->` and `-. t .->`. A thick `render === query` on the page was drawn
 * for a reader, unbacked by any manifest, and read by nothing. `create-ultimate` is the near miss
 * the run length answers: a node id carries single `-`, never two.
 */
const OTHER_LINK = /[-=.]{2,}/;
const DIRECTIVE =
  /^(graph|flowchart|subgraph|end|classDef|class|style|linkStyle|click|direction)\b/;
const NODE = /^[A-Za-z_][\w.-]*$/;

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
}

export interface PackageGraph {
  readonly blocks: number;
  readonly edges: readonly GraphEdge[];
  readonly nodes: ReadonlySet<string>;
  /** Lines that hold a link operator this rule cannot read. Never silence. */
  readonly unreadable: readonly NumberedLine[];
}

export function readPackageGraph(markdown: string): PackageGraph {
  const { blocks, lines } = mermaidLines(markdown);
  const edges: GraphEdge[] = [];
  const nodes = new Set<string>();
  const unreadable: NumberedLine[] = [];
  for (const entry of lines) {
    const text = cleanMermaid(entry.text);
    if (text === '') continue;
    const edge = EDGE.exec(text);
    if (edge !== null) {
      const from = edge[1] as string;
      const to = edge[2] as string;
      edges.push({ from, to, line: entry.line });
      nodes.add(from);
      nodes.add(to);
      continue;
    }
    // A directive is never an edge, so reading it first can hide no arrow — while reading it last
    // would red the gate on a `classDef` that happens to carry a run, a finding no edit can clear.
    if (DIRECTIVE.test(text)) continue;
    if (OTHER_LINK.test(text)) {
      unreadable.push(entry);
      continue;
    }
    for (const token of text.split(/[;,]/)) {
      const name = token.trim();
      if (NODE.test(name)) nodes.add(name);
    }
  }
  return { blocks, edges, nodes, unreadable };
}

/** The heading whose table names every package. Rows below it, until the next `## `. */
const PACKAGE_TABLE_HEADING = '## Every package';

/** `| `cli` | 5 | … |` -> `{ dir: 'cli', tier: 5 }`. The tier cell may qualify itself
 *  (`unlisted (6)`), so the FIRST integer in it is the claim — not the whole cell. */
const TABLE_ROW = /^\|\s*`([^`]+)`\s*\|([^|]*)\|/;

export interface PackageTableRow {
  readonly dir: string;
  /** `undefined` when the tier cell states no number at all — reported, never assumed. */
  readonly tier: number | undefined;
  readonly line: number;
}

/**
 * Every row of the `## Every package` table. A SECOND prose copy of the same fact the mermaid
 * graph draws, and until 2026-08-24 nothing read it: `scraping` was absent from it while the
 * graph's own presence rule twelve lines below passed, because that rule reads the fence and this
 * table is not in one. The same defect, one table over — which is the pattern this repo keeps
 * re-shipping and axiom 3 exists to stop.
 */
export function packageTableRows(markdown: string): readonly PackageTableRow[] {
  const rows: PackageTableRow[] = [];
  const lines = markdown.split('\n');
  let inside = false;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (text.startsWith('## ')) {
      inside = text.trim() === PACKAGE_TABLE_HEADING;
      continue;
    }
    if (!inside) continue;
    const match = TABLE_ROW.exec(text.trim());
    if (match === null) continue;
    const dir = match[1] as string;
    const digits = /\d+/.exec(match[2] as string);
    rows.push({
      dir,
      tier: digits === null ? undefined : Number(digits[0]),
      line: index + 1,
    });
  }
  return rows;
}

export interface GraphWorkspace {
  /** Directory under `packages/`, which is also the node name on the graph. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly tier: number;
  /** Every in-repo dependency, by package NAME. */
  readonly deps: readonly string[];
}

export interface PackageGraphInput {
  /** `undefined` when the page could not be read — a state that must fail, never skip. */
  readonly markdown: string | undefined;
  readonly workspaces: readonly GraphWorkspace[];
  /** Manifests that would not parse. A finding, never an unhandled rejection with no `--json`. */
  readonly unreadable?: readonly string[];
}

const unscanned = (cause: string, fix: string, at = PACKAGE_MAP): Finding => ({
  // Written as a literal at every site. This file is where the hole was found (#277): `scanCodes`
  // read a `code:` STRING only, so a code behind an identifier was in no manifest, needed no wiki
  // row and was invisible to `bun run gate-codes`. It now resolves a module-scope const in the
  // same file and refuses everything else — a literal is still the form with nothing in between.
  code: 'X_DOC_PACKAGE_GRAPH_UNSCANNED',
  cause,
  fix,
  at,
});

/**
 * Two rules, both one-directional on purpose.
 *
 * BACKING: every arrow drawn must be a declared dependency. The reverse is NOT checked — the graph
 * abridges deliberately (`cli` declares 23 and draws 4), and a rule demanding every edge would
 * turn one readable picture into an unreadable one.
 *
 * PRESENCE: every publishable workspace must be a node. A package absent from the map is invisible
 * to the reader the map exists for, which is how `scraping` stayed off it for two majors.
 */
export function checkPackageMapGraph(input: PackageGraphInput): readonly Finding[] {
  if (input.markdown === undefined) {
    return [
      unscanned(
        `${PACKAGE_MAP} could not be read, so no arrow was checked`,
        `restore ${PACKAGE_MAP}, or point PACKAGE_MAP in scripts/package-map-graph.ts at the page that draws the graph`,
      ),
    ];
  }
  // Before the vacuity check below, which would otherwise blame the caller's cwd for a broken file.
  if (input.unreadable !== undefined && input.unreadable.length > 0) {
    return input.unreadable.map((at) =>
      unscanned(
        `${at} could not be read as a JSON manifest, so the dependencies behind every arrow out of that package are unknown and no arrow was checked`,
        `repair the manifest at ${at} — \`bun -e 'await Bun.file("<path>").json()'\` prints the parse error and its offset for one file, and \`bun run scripts/list-workspaces.ts --json\` names every manifest this rule reads`,
        at,
      ),
    );
  }
  if (input.workspaces.length === 0) {
    return [
      unscanned(
        'no packages/*/package.json was read, so every arrow would have been unbacked',
        'run `bun run scripts/package-map-graph.ts` from the repo root',
        'scripts/package-map-graph.ts',
      ),
    ];
  }
  const graph = readPackageGraph(input.markdown);
  if (graph.blocks === 0 || graph.edges.length === 0) {
    return [
      unscanned(
        `${PACKAGE_MAP} holds ${String(graph.blocks)} \`\`\`mermaid block(s) and ${String(graph.edges.length)} \`a --> b\` edge(s), so this rule read nothing`,
        `draw the dependency graph in a \`\`\`mermaid fence in ${PACKAGE_MAP}, one \`a --> b\` per line`,
      ),
    ];
  }
  const findings: Finding[] = graph.unreadable.map((entry) =>
    unscanned(
      `${PACKAGE_MAP}:${String(entry.line)} holds a mermaid link this rule cannot read: ${entry.text.trim()}`,
      `rewrite ${PACKAGE_MAP}:${String(entry.line)} as \`a --> b\`, one edge per line — that is the only form scripts/package-map-graph.ts reads`,
      `${PACKAGE_MAP}:${String(entry.line)}`,
    ),
  );
  const byDir = new Map(input.workspaces.map((workspace) => [workspace.dir, workspace]));
  for (const edge of graph.edges) {
    const at = `${PACKAGE_MAP}:${String(edge.line)}`;
    const from = byDir.get(edge.from);
    const to = byDir.get(edge.to);
    const unknown = from === undefined ? edge.from : to === undefined ? edge.to : undefined;
    if (unknown !== undefined) {
      findings.push({
        code: 'X_DOC_PACKAGE_GRAPH_STALE',
        cause: `${at} draws ${edge.from} --> ${edge.to}, and packages/${unknown} is not a workspace`,
        fix: `delete the \`${edge.from} --> ${edge.to}\` line at ${at}, or rename ${unknown} to a directory that exists under packages/ — \`bun run scripts/list-workspaces.ts --json\` lists them`,
        at,
      });
      continue;
    }
    if (from === undefined || to === undefined || from.deps.includes(to.name)) continue;
    findings.push({
      code: 'X_DOC_PACKAGE_GRAPH_STALE',
      cause: `${at} draws ${edge.from} --> ${edge.to}, and packages/${edge.from}/package.json declares no dependency on ${to.name}`,
      fix: `delete the \`${edge.from} --> ${edge.to}\` line at ${at}; if the dependency is the missing half instead, add "${to.name}": "${to.version}" to dependencies in packages/${edge.from}/package.json and re-run \`bun install\``,
      at,
    });
  }
  for (const workspace of input.workspaces) {
    if (workspace.private || graph.nodes.has(workspace.dir)) continue;
    findings.push({
      code: 'X_DOC_PACKAGE_GRAPH_STALE',
      cause: `${workspace.name} publishes and ${PACKAGE_MAP} draws no node for it`,
      fix: `add \`${workspace.dir}\` to the tier-${String(workspace.tier)} subgraph in ${PACKAGE_MAP}, with an arrow per dependency in packages/${workspace.dir}/package.json`,
      at: PACKAGE_MAP,
    });
  }
  const rows = packageTableRows(input.markdown);
  // Vacuity guard, first: a renamed heading would make every row check below pass over nothing,
  // which is the failure mode the whole file exists to prevent, reintroduced one level up.
  if (rows.length === 0) {
    findings.push(
      unscanned(
        `${PACKAGE_MAP} holds no \`${PACKAGE_TABLE_HEADING}\` table row, so no package's row was checked`,
        `restore the \`${PACKAGE_TABLE_HEADING}\` heading in ${PACKAGE_MAP} with one \`| \`name\` | tier | … |\` row per package, or point PACKAGE_TABLE_HEADING in scripts/package-map-graph.ts at the heading that carries them`,
      ),
    );
    return findings;
  }
  const rowByDir = new Map(rows.map((row) => [row.dir, row]));
  for (const workspace of input.workspaces) {
    if (workspace.private) continue;
    const row = rowByDir.get(workspace.dir);
    if (row === undefined) {
      findings.push({
        code: 'X_DOC_PACKAGE_GRAPH_STALE',
        cause: `${workspace.name} publishes and ${PACKAGE_MAP}'s \`${PACKAGE_TABLE_HEADING}\` table carries no row for it`,
        fix: `add a \`| \`${workspace.dir}\` | ${String(workspace.tier)} | … |\` row to the \`${PACKAGE_TABLE_HEADING}\` table in ${PACKAGE_MAP}`,
        at: PACKAGE_MAP,
      });
      continue;
    }
    // The tier is checked because a row can be present and WRONG: `ui` sat in the wrong tier
    // subgraph on this same page, and a reader trusts the number more than the placement.
    if (row.tier === workspace.tier) continue;
    findings.push({
      code: 'X_DOC_PACKAGE_GRAPH_STALE',
      cause: `${PACKAGE_MAP}:${String(row.line)} puts ${workspace.dir} at tier ${row.tier === undefined ? 'no stated tier' : String(row.tier)}, and scripts/lib/tiers.ts puts it at ${String(workspace.tier)}`,
      fix: `set the tier cell at ${PACKAGE_MAP}:${String(row.line)} to ${String(workspace.tier)}, or move ${workspace.dir} in scripts/lib/tiers.ts — the executable table is the one \`bun run boundaries\` enforces`,
      at: `${PACKAGE_MAP}:${String(row.line)}`,
    });
  }
  const dirs = new Set(input.workspaces.map((workspace) => workspace.dir));
  for (const row of rows) {
    if (dirs.has(row.dir)) continue;
    findings.push({
      code: 'X_DOC_PACKAGE_GRAPH_STALE',
      cause: `${PACKAGE_MAP}:${String(row.line)} carries a row for ${row.dir}, and packages/${row.dir} is not a workspace`,
      fix: `delete the row at ${PACKAGE_MAP}:${String(row.line)}, or rename ${row.dir} to a directory that exists under packages/ — \`bun run scripts/list-workspaces.ts --json\` lists them`,
      at: `${PACKAGE_MAP}:${String(row.line)}`,
    });
  }
  return findings;
}

/** A JSON object, narrowed. The hand parse that replaces an `as RawManifest` on a value
 *  `Bun.file().json()` hands over untyped: a manifest is whatever is on disk, not what we hoped. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every dependency NAME a parsed manifest declares, across both fields this rule reads. */
export const manifestDeps = (parsed: unknown): readonly string[] =>
  !isRecord(parsed)
    ? []
    : ['dependencies', 'peerDependencies'].flatMap((field) => {
        const held = parsed[field];
        return isRecord(held) ? Object.keys(held) : [];
      });

export interface GraphWorkspaces {
  readonly workspaces: readonly GraphWorkspace[];
  /** Repo-relative manifests that would not parse — reported, never thrown out of the process. */
  readonly unreadable: readonly string[];
}

/**
 * In-repo dependencies only: an arrow on this graph is never `nats` or `sass`.
 *
 * Enumerated HERE rather than through `listWorkspaces`, which now refuses an unreadable manifest
 * with `X_WORKSPACE_MANIFEST_UNREADABLE` (#281). Refusing is right for a release tool and wrong
 * for this one: a broken manifest is this rule's own FINDING, and one file must not take the other
 * twenty-nine out of the answer. Both halves read `readWorkspaceManifest`, so "unreadable" means
 * the same thing on both sides of that seam — which the try/catch pair this replaced did not: it
 * caught the throw and then re-globbed with a bare `.json()`, so JSON that parsed to `[]` was
 * unreadable to one half and fine to the other, and the finding named the glob instead of the file.
 */
export async function readGraphWorkspaces(root: string): Promise<GraphWorkspaces> {
  const read: { readonly dir: string; readonly manifest: PackageJson }[] = [];
  const unreadable: string[] = [];
  for await (const relative of new Bun.Glob(PACKAGES_GLOB).scan({ cwd: root })) {
    const manifest = await readWorkspaceManifest(join(root, relative));
    if (manifest.kind !== 'read') {
      unreadable.push(relative);
      continue;
    }
    read.push({ dir: relative.split('/')[1] ?? '', manifest: manifest.manifest });
  }
  const named = read.map((one) => ({
    dir: one.dir,
    name: one.manifest.name ?? `@ultimat3/${one.dir}`,
    version: one.manifest.version ?? '0.0.0',
    private: one.manifest.private === true,
    tier: tierOf(one.dir),
    manifest: one.manifest,
  }));
  const names = new Set(named.map((one) => one.name));
  const workspaces: GraphWorkspace[] = named
    .map(({ manifest, ...one }) => ({
      ...one,
      deps: manifestDeps(manifest).filter((name) => names.has(name)),
    }))
    .sort((a, b) => a.tier - b.tier || a.dir.localeCompare(b.dir));
  return { workspaces, unreadable: unreadable.sort() };
}

export async function packageMapGraphFindings(root: string): Promise<readonly Finding[]> {
  const page = Bun.file(`${root}/${PACKAGE_MAP}`);
  const { workspaces, unreadable } = await readGraphWorkspaces(root);
  return checkPackageMapGraph({
    markdown: (await page.exists()) ? await page.text() : undefined,
    workspaces,
    unreadable,
  });
}

if (import.meta.main) {
  const root = repoRoot();
  const args = parseScriptArgs(Bun.argv.slice(2));
  const page = Bun.file(`${root}/${PACKAGE_MAP}`);
  const markdown = (await page.exists()) ? await page.text() : undefined;
  const { workspaces, unreadable } = await readGraphWorkspaces(root);
  const findings = checkPackageMapGraph({ markdown, workspaces, unreadable });
  const graph = markdown === undefined ? undefined : readPackageGraph(markdown);
  const rows = markdown === undefined ? [] : packageTableRows(markdown);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${String(graph?.edges.length ?? 0)} arrows in ${PACKAGE_MAP}, every one a declared dependency, every publishable package a node AND a row of the ${String(rows.length)}-row \`${PACKAGE_TABLE_HEADING.slice(3)}\` table, each at its declared tier`
          : `${String(findings.length)} arrow(s) or package(s) the package map and the manifests disagree about`,
      findings,
      data: {
        edges: graph?.edges ?? [],
        nodes: [...(graph?.nodes ?? [])],
        tableRows: rows,
        workspaces: workspaces.length,
      },
    },
    args.json,
  );
}
