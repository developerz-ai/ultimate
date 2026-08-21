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

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces } from './lib/workspaces';

const SCRIPT = 'package-map-graph';

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
/** Every OTHER mermaid link operator, so an edge this rule cannot parse is reported rather than
 * silently absent — a graph check that skips what it does not understand answers a clean page. */
const OTHER_LINK = /-\.-|={2,}[>ox]|--[xo]|<--|-{3,}/;
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
    if (text.includes('-->') || OTHER_LINK.test(text)) {
      unreadable.push(entry);
      continue;
    }
    if (DIRECTIVE.test(text)) continue;
    for (const token of text.split(/[;,]/)) {
      const name = token.trim();
      if (NODE.test(name)) nodes.add(name);
    }
  }
  return { blocks, edges, nodes, unreadable };
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
}

const unscanned = (cause: string, fix: string, at = PACKAGE_MAP): Finding => ({
  // Written as a literal at every site, never through a const: `scanCodes` reads a `code:` STRING
  // and a code behind an identifier is a code the manifest, the wiki check and `bun run gate-codes`
  // cannot see.
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
  return findings;
}

interface RawManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** In-repo dependencies only: an arrow on this graph is never `nats` or `sass`. */
export async function readGraphWorkspaces(root: string): Promise<readonly GraphWorkspace[]> {
  const workspaces = await listWorkspaces(root);
  const names = new Set(workspaces.map((workspace) => workspace.name));
  return Promise.all(
    workspaces.map(async (workspace) => {
      const manifest = (await Bun.file(`${workspace.path}/package.json`).json()) as RawManifest;
      const declared = { ...manifest.dependencies, ...manifest.peerDependencies };
      return {
        dir: workspace.dir,
        name: workspace.name,
        version: workspace.version,
        private: workspace.private,
        tier: workspace.tier,
        deps: Object.keys(declared).filter((name) => names.has(name)),
      };
    }),
  );
}

export async function packageMapGraphFindings(root: string): Promise<readonly Finding[]> {
  const page = Bun.file(`${root}/${PACKAGE_MAP}`);
  return checkPackageMapGraph({
    markdown: (await page.exists()) ? await page.text() : undefined,
    workspaces: await readGraphWorkspaces(root),
  });
}

if (import.meta.main) {
  const root = repoRoot();
  const args = parseScriptArgs(Bun.argv.slice(2));
  const page = Bun.file(`${root}/${PACKAGE_MAP}`);
  const markdown = (await page.exists()) ? await page.text() : undefined;
  const workspaces = await readGraphWorkspaces(root);
  const findings = checkPackageMapGraph({ markdown, workspaces });
  const graph = markdown === undefined ? undefined : readPackageGraph(markdown);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${String(graph?.edges.length ?? 0)} arrows in ${PACKAGE_MAP}, every one a declared dependency, every publishable package on the graph`
          : `${String(findings.length)} arrow(s) or package(s) the package map and the manifests disagree about`,
      findings,
      data: {
        edges: graph?.edges ?? [],
        nodes: [...(graph?.nodes ?? [])],
        workspaces: workspaces.length,
      },
    },
    args.json,
  );
}
