import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { SIDEWAYS_ALLOW } from './lib/tiers';
import {
  APP_HEADING,
  appFirstFindings,
  fillBlocks,
  homeSummaries,
  llmsDrift,
  llmsTxtFindings,
  packageLine,
  REPO_HEADING,
  sidewaysLines,
  wikiLines,
} from './llms-txt';

const OPEN_P = '<!-- generated: packages — bun run llms-txt --write -->';
const OPEN_W = '<!-- generated: wiki — bun run llms-txt --write -->';
const OPEN_S = '<!-- generated: sideways — bun run llms-txt --write -->';
const CLOSE = '<!-- end generated -->';
const FILE = ['# t', OPEN_S, CLOSE, OPEN_P, '- old', CLOSE, 'prose', OPEN_W, CLOSE, ''].join('\n');

describe('unit · llms.txt lists are generated, and drift is refused', () => {
  test('a package line carries its tier, description and both links', () => {
    expect(
      packageLine({ name: '@ultimat3/notify', dir: 'notify', tier: 4, description: 'N' }),
    ).toBe(
      '- [@ultimat3/notify](https://raw.githubusercontent.com/developerz-ai/ultimate/main/packages/notify/README.md): tier 4 — N. Boundary and deps: [CLAUDE.md](https://raw.githubusercontent.com/developerz-ai/ultimate/main/packages/notify/CLAUDE.md).',
    );
  });

  test('the wiki list is the sidebar, in its order, summarised from Home', () => {
    const sidebar = '**Start**\n\n- [Money](Money)\n- [FAQ](FAQ)\n- [Money](Money)\n';
    const home = '| [Money](Money) | never a float |\n';
    expect(homeSummaries(home).get('Money')).toBe('never a float');
    const lines = wikiLines(sidebar, home);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEndWith('Money.md): never a float.');
    expect(lines[2]).toEndWith('FAQ.md).');
  });

  // The edge list was hand-written beside `SIDEWAYS_ALLOW` and had already lost `core -> schema`.
  test('the sideways-edge line is SIDEWAYS_ALLOW, every edge, in its order', () => {
    const edges = Object.entries(SIDEWAYS_ALLOW).flatMap(([from, to]) =>
      to.map((target) => `\`${from} -> ${target}\``),
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(sidewaysLines(SIDEWAYS_ALLOW)).toEqual([
      `Declared sideways edges: ${edges.join(', ')}.`,
    ]);
    expect(sidewaysLines({ a: ['b'] })).toEqual(['Declared sideways edges: `a -> b`.']);
  });

  test('only the marked blocks are rewritten; prose is kept', () => {
    const filled = fillBlocks(FILE, { packages: ['- new'], wiki: ['- w'], sideways: ['e'] });
    expect(filled.missing).toEqual([]);
    expect(filled.text).toBe(
      ['# t', OPEN_S, 'e', CLOSE, OPEN_P, '- new', CLOSE, 'prose', OPEN_W, '- w', CLOSE, ''].join(
        '\n',
      ),
    );
  });

  test('a missing entry and an extra entry are each X_LLMS_TXT_DRIFT, naming the line', () => {
    const filled = fillBlocks(FILE, { packages: ['- new'], wiki: [], sideways: [] });
    const causes = llmsDrift(FILE, filled.text, filled.missing).map((f) => `${f.code} ${f.cause}`);
    expect(causes).toEqual([
      'X_LLMS_TXT_DRIFT llms.txt is missing - new',
      'X_LLMS_TXT_DRIFT llms.txt carries an entry nothing generates: - old',
    ]);
  });

  test('the right entries in the wrong order are X_LLMS_TXT_DRIFT too', () => {
    const filled = fillBlocks(FILE, { packages: ['- a', '- b'], wiki: [], sideways: [] });
    const swapped = filled.text.replace('- a\n- b', '- b\n- a');
    expect(llmsDrift(filled.text, filled.text, filled.missing)).toEqual([]);
    expect(llmsDrift(swapped, filled.text, filled.missing).map((f) => f.cause)).toEqual([
      'llms.txt lists the generated entries out of the order the generator writes them',
    ]);
  });

  test('a block whose markers are gone is refused, never skipped', () => {
    const filled = fillBlocks('# no markers\n', { packages: ['- x'], wiki: [], sideways: [] });
    expect(filled.missing).toEqual(['packages', 'wiki', 'sideways']);
    expect(llmsDrift('# no markers\n', filled.text, filled.missing)).toHaveLength(3);
  });
});

// `README.md` sends every agent to llms.txt, and most of them are building an app, not this repo.
// Its first block was `bun run scripts/…` — commands an app does not have.
describe('unit · llms.txt leads with the app author', () => {
  const APP = `## ${APP_HEADING}\n\n- \`bunx create-ultimate myapp\`\n`;
  const REPO = `## ${REPO_HEADING}\n\n- \`bun run scripts/list-workspaces.ts\`\n`;

  test('app section first, repository section after it, is clean', () => {
    expect(appFirstFindings(`# t\n\n> s\n\n${APP}\n${REPO}`)).toEqual([]);
  });

  test('a repository command before the app section is refused', () => {
    const causes = appFirstFindings(`# t\n\n${REPO}\n${APP}`).map((f) => f.cause);
    expect(causes.some((cause) => cause.includes(`rather than "## ${APP_HEADING}"`))).toBe(true);
  });

  test('a repository-only command inside the app section is refused, naming it', () => {
    const leaky = `## ${APP_HEADING}\n\n- \`bun run scripts/release.ts\`\n\n${REPO}`;
    const findings = appFirstFindings(leaky);
    expect(findings.map((f) => f.code)).toEqual(['X_LLMS_TXT_DRIFT']);
    expect(findings[0]?.cause).toContain('bun run scripts/');
  });

  test('no repository heading at all is refused', () => {
    expect(appFirstFindings(`# t\n\n${APP}`)).toHaveLength(1);
  });

  test('the real file passes, and its first section holds no bun run scripts/', async () => {
    const text = await Bun.file(`${repoRoot()}/llms.txt`).text();
    expect(appFirstFindings(text)).toEqual([]);
    const first = text.slice(
      text.indexOf('\n## '),
      text.indexOf('\n## ', text.indexOf('\n## ') + 1),
    );
    expect(first).toContain(APP_HEADING);
    expect(first).not.toContain('bun run scripts/');
  });
});

describe('the real tree', () => {
  test(
    'llms.txt is what the generator writes',
    async () => {
      expect(await llmsTxtFindings(repoRoot())).toEqual([]);
      const text = await Bun.file(`${repoRoot()}/llms.txt`).text();
      expect(text).toContain('[@ultimat3/notify]');
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
