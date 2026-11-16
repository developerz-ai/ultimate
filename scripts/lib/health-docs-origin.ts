// The docs-site origin row: whether the docs site can publish where it says it does — the
// `DOCS_SITE_ORIGIN` variable every deploy-docs-site.yml job is gated on is set, GitHub Pages is on
// and serves that host, and its certificate is approved and enforced. Each defect is named with the
// one `gh` call that repairs it; the host is read, never spelled here.

import { forbiddenReason, isForbidden } from './health-forbidden';
import { jsonDocument } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import type { RunResult } from './run';

const VARIABLE = 'DOCS_SITE_ORIGIN';
const VARIABLE_ARGS = ['variable', 'list', '--json', 'name,value'] as const;
const PAGES_ARGS = ['api', 'repos/{owner}/{repo}/pages'] as const;
const PAGES = 'gh api -X PUT repos/{owner}/{repo}/pages';

// Exported for the brief's test and the reader's: a re-run is the same two queries.
export const DOCS_ORIGIN_COMMAND = `gh ${VARIABLE_ARGS.join(' ')}; gh ${PAGES_ARGS.join(' ')}`;

/** The token refused to list variables: no answer about them. */
export const FORBIDDEN = 'forbidden';

export interface DocsOriginRead {
  /** The variable list, or `FORBIDDEN`. */
  readonly variables: unknown;
  readonly pages: unknown;
}

const NOT_FOUND = { message: 'Not Found' } as const;

type Gh = (args: readonly string[], cwd: string) => Promise<RunResult>;

export const docsOriginReader = async (root: string, ghRunner: Gh): Promise<DocsOriginRead> => {
  const listed = await ghRunner(VARIABLE_ARGS, root);
  const variables =
    !listed.ok && isForbidden(listed.output) ? FORBIDDEN : jsonDocument(listed.output);
  // On a 404 gh prints the API's body pretty-printed, then its own `gh: Not Found (HTTP 404)` line,
  // so no one line parses: the status line is the signal that Pages is off.
  const site = await ghRunner(PAGES_ARGS, root);
  const pages =
    !site.ok && /\bHTTP 404\b/.test(site.output) ? NOT_FOUND : jsonDocument(site.output);
  return { variables, pages };
};

const rec = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** The origin's value; `null` when the list is readable and names no such variable. */
const originOf = (value: unknown): string | null | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entry = value.map(rec).find((one) => one?.['name'] === VARIABLE);
  return entry === undefined ? null : (text(entry['value']) ?? null);
};

const hostOf = (origin: string): string => origin.replace(/^[a-z]+:\/\//, '').split('/')[0] ?? '';

const unreadable = (detail: string): Finding => ({
  code: 'X_HEALTH_ROW_UNREADABLE',
  cause: `the docs-site-origin row could not be read: ${DOCS_ORIGIN_COMMAND} — ${detail}`,
  fix: 'bun run scripts/health.ts --json',
  at: 'scripts/health.ts',
});

export const judgeDocsOrigin = (read: DocsOriginRead, nowMs: number): RowVerdict | Finding => {
  const base = { row: 'docs-site-origin' as const };
  const ill = (reason: string, fix: string): RowVerdict => ({
    ...base,
    verdict: 'unhealthy',
    reason,
    fix,
  });
  if (read.variables === FORBIDDEN) {
    const reason = forbiddenReason('repository variables');
    return { ...base, verdict: 'unverdicted', reason, fix: DOCS_ORIGIN_COMMAND };
  }
  const origin = originOf(read.variables);
  const pages = rec(read.pages);
  if (origin === undefined) return unreadable('gh printed no JSON variable list');
  if (pages === undefined) return unreadable('gh printed no JSON Pages document');
  const cname = text(pages['cname']);
  if (origin === null) {
    return ill(
      `${VARIABLE} is unset: every deploy-docs-site.yml job skips, nothing publishes`,
      `gh variable set ${VARIABLE} --body https://${cname ?? '<host>'}`,
    );
  }
  if (pages['message'] === 'Not Found') {
    return ill(
      `${VARIABLE} is set but GitHub Pages is off: the deploy has nowhere to publish`,
      'gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow',
    );
  }
  if (pages['message'] !== undefined)
    return unreadable(`the Pages API answered ${pages['message']}`);
  const host = hostOf(origin);
  if (cname !== host) {
    return ill(
      `Pages serves ${cname ?? 'no custom domain'}, not ${host}`,
      `${PAGES} -f cname=${host}`,
    );
  }
  const cert = rec(pages['https_certificate']);
  const expires = Date.parse(text(cert?.['expires_at']) ?? '');
  if (cert?.['state'] !== 'approved' || !(expires > nowMs)) {
    return ill(
      `the certificate for ${host} is ${text(cert?.['state']) ?? 'absent'}${Number.isFinite(expires) && expires <= nowMs ? ', expired' : ''} — re-setting the domain asks for a new one`,
      `${PAGES} -f cname=${host}`,
    );
  }
  if (pages['https_enforced'] !== true) {
    return ill(`${host} serves plain HTTP too`, `${PAGES} -F https_enforced=true`);
  }
  return {
    ...base,
    verdict: 'healthy',
    reason: `Pages serves ${host} over an approved certificate`,
  };
};
