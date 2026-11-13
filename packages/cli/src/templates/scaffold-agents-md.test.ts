// AGENTS.md conformance: the file is the cross-vendor brief, read by any coding agent arriving cold
// in a shell with no global `x`. So every backticked command in it must run as written — a shipped
// `bunx x` command, or a script the scaffold's own package.json declares — and no text in it may
// name a vendor's product, apart from the literal `.claude/` path the harness lives under.

import { describe, expect, test } from 'bun:test';
import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
import { planNewApp } from '../cmd-new';
import { NEW_SHAPES } from '../new-shapes';
import { SPECS } from '../registry';
import { names } from './naming';
import { docsFiles } from './scaffold-docs';
import { repoFiles } from './scaffold-repo';

const app = names('ledger-demo');

const textAt = (
  files: readonly { path: string; contents: string | Uint8Array }[],
  path: string,
) => {
  const found = files.find((file) => file.path === path);
  if (found === undefined || typeof found.contents !== 'string') {
    return expect.unreachable(`x new writes no text ${path}`);
  }
  return found.contents;
};

const agentsMd = (): string => textAt(docsFiles(app), 'AGENTS.md');

const scripts = (): ReadonlySet<string> => {
  const pkg: unknown = JSON.parse(textAt(repoFiles(app, '0.0.0', true), 'package.json'));
  const declared = (pkg as { readonly scripts?: Record<string, string> }).scripts ?? {};
  return new Set(Object.keys(declared));
};

/** A planned command exits X_NOT_IMPLEMENTED, so citing one is the same dead end as a typo. */
const SHIPPED = new Map(
  SPECS.filter((spec) => !spec.summary.endsWith('(planned)')).map((spec) => [
    spec.name,
    new Set(spec.subcommands ?? []),
  ]),
);

/** Every backticked span, whitespace folded — a span may wrap across a line. */
const spans = (text: string): readonly string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim());

const WORD = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/;

/** What is wrong with one span as a command, or `undefined` when it is not one or it runs. */
export function brokenCommand(span: string, declared: ReadonlySet<string>): string | undefined {
  if (/^x\s/.test(span)) return `${span}: there is no global x — spell it bunx x`;
  for (const run of span.matchAll(/\bbun run ([a-z][a-z0-9:-]*)/g)) {
    if (!declared.has(run[1] ?? '')) return `${span}: package.json declares no "${run[1]}" script`;
  }
  const cli = /^bunx (?:x|@ultimat3\/cli) (\S+)(?: (\S+))?/.exec(span);
  if (cli === null) return undefined;
  const [, command = '', next] = cli;
  // `bunx x …` names the spelling, not a command: a placeholder is not a citation.
  if (!WORD.test(command)) return undefined;
  const subs = SHIPPED.get(command);
  if (subs === undefined) return `${span}: x ships no "${command}" command`;
  if (next !== undefined && WORD.test(next) && subs.size > 0 && !subs.has(next)) {
    return `${span}: x ${command} has no "${next}" subcommand`;
  }
  return undefined;
}

/** Vendor and platform names, matched once the literal `.claude/` path is taken out. */
const VENDOR =
  /claude|anthropic|openai|chatgpt|codex|cursor|copilot|gemini|windsurf|developerz|\.dz\//i;

describe('unit · AGENTS.md runs as written, for any agent', () => {
  test('the check itself refuses a bare x, an undeclared script and an unshipped command', () => {
    const declared = new Set(['verify']);
    expect(brokenCommand('x g resource', declared)).toContain('no global x');
    expect(brokenCommand('bun run deploy', declared)).toContain('"deploy"');
    expect(brokenCommand('bunx x lint', declared)).toContain('"lint"');
    expect(brokenCommand('bunx x db squash', declared)).toContain('"squash"');
    expect(brokenCommand('bunx @ultimat3/cli mcp serve --transport stdio', declared)).toBe(
      undefined,
    );
    expect(brokenCommand('bun run verify', declared)).toBeUndefined();
    expect(brokenCommand('bun run check', declared)).toContain('"check"');
    expect(brokenCommand('x.manifest.json', declared)).toBeUndefined();
  });

  test('every backticked command in AGENTS.md resolves', () => {
    const declared = scripts();
    const broken = spans(agentsMd()).flatMap((span) => brokenCommand(span, declared) ?? []);
    expect(broken).toEqual([]);
    // Not vacuous: the file does cite commands of each kind.
    expect(spans(agentsMd()).filter((span) => span.startsWith('bunx x ')).length).toBeGreaterThan(
      5,
    );
    expect(spans(agentsMd())).toContain('bun run verify');
  });

  test('no text names a vendor other than the literal .claude/ path', () => {
    expect(VENDOR.test('see CLAUDE.md')).toBe(true);
    const text = agentsMd().replaceAll('.claude/', '');
    expect(text.match(VENDOR)).toBeNull();
  });

  test('it stays inside the AGENTS.md budget the manifest step enforces', () => {
    expect(new TextEncoder().encode(agentsMd()).byteLength).toBeLessThan(AGENTS_MD_MAX_BYTES);
  });

  // Every scaffold the `scaffold-smoke` matrix gates, measured as it lands: a shape's overlay edits
  // CLAUDE.md, which AGENTS.md links to, so the default scaffold's headroom is not a shape's. A row
  // added to the shared conventions passed the one-scaffold case above with 50 B to spare and put
  // three shapes over, found only by `X_AGENTS_MD_TOO_LARGE` on CI. The longest matrix name, since
  // the app's name is spelled into the file.
  const scaffolds = [
    { label: 'default', options: { example: true } },
    { label: '--no-example', options: { example: false } },
    ...NEW_SHAPES.map((shape) => ({
      label: `--shape ${shape}`,
      options: { example: true, shape },
    })),
  ] as const;
  for (const { label, options } of scaffolds) {
    test(`x new ${label}: CLAUDE.md and the AGENTS.md copy stay inside the budget`, () => {
      const files = planNewApp({ name: 'dashboardapp', ...options });
      for (const path of ['CLAUDE.md', 'AGENTS.md']) {
        const bytes = new TextEncoder().encode(textAt(files, path)).byteLength;
        expect({ path, bytes, over: bytes > AGENTS_MD_MAX_BYTES }).toEqual({
          path,
          bytes,
          over: false,
        });
      }
    });
  }
});
