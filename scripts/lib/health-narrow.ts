// The shapes of a health row's child documents, and the narrowing that reads them out of a child's
// parsed stdout — never throws: an entry that does not parse is dropped, never invented, and a
// document that does not parse at all comes back undefined, for scripts/health.ts to refuse on.

/** One workflow run as `gh run list` / `x ci --json` name it: `conclusion` is null while running. */
export interface RunRow {
  readonly conclusion: string | null;
  readonly status?: string | undefined;
  readonly headSha?: string | undefined;
  readonly event?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly id?: number | undefined;
  readonly title?: string | undefined;
}

/** One open `registry-drift` issue, as `gh issue list` names it. */
export interface AlarmIssue {
  readonly number: number;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  /** The newest comment predates today's 06:17 UTC audit: drift stopped re-firing, issue left open. */
  readonly latched?: boolean;
}

/** One statusCheckRollup entry: a CheckRun reads by status/conclusion, a StatusContext by state. */
export interface PrCheck {
  readonly status?: string | undefined;
  readonly conclusion?: string | undefined;
  readonly state?: string | undefined;
}

/** One open Dependabot PR, as `gh pr list --app dependabot` names it. */
export interface DependabotPr {
  readonly number: number;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly url?: string | undefined;
  readonly state?: string | undefined;
  /** True while autoMergeRequest is non-null; undefined when the field never answered. */
  readonly autoMerge?: boolean | undefined;
  /** The narrowed statusCheckRollup — entries with nothing readable are dropped, never invented. */
  readonly checks?: readonly PrCheck[] | undefined;
}

// ——— Narrowing: a child's parsed `unknown` into the shapes the rules read. Never throws. ———

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const rec = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** `x ci --json`'s answer for row 1. `runNotFound` is its X_CI_RUN_NOT_FOUND refusal. */
export interface CiDoc {
  readonly ok: boolean;
  readonly runNotFound: boolean;
  readonly runs: readonly RunRow[];
}

export function narrowCiDoc(value: unknown): CiDoc | undefined {
  const doc = rec(value);
  if (doc === undefined || typeof doc['ok'] !== 'boolean') return undefined;
  const findings = Array.isArray(doc['findings']) ? doc['findings'] : [];
  return {
    ok: doc['ok'],
    runNotFound: findings.some((one) => rec(one)?.['code'] === 'X_CI_RUN_NOT_FOUND'),
    runs: narrowRuns(rec(doc['data'])?.['runs']),
  };
}

/** Runs out of a `gh run list` / `x ci` document; an entry with no readable conclusion is dropped. */
export function narrowRuns(value: unknown): readonly RunRow[] {
  return (Array.isArray(value) ? value : []).flatMap((one) => {
    const row = rec(one);
    const conclusion = row?.['conclusion'];
    if (row === undefined || !(conclusion === null || typeof conclusion === 'string')) return [];
    return [
      {
        conclusion,
        status: str(row['status']),
        headSha: str(row['headSha']),
        event: str(row['event']),
        headBranch: str(row['headBranch']),
        url: str(row['url']),
        createdAt: str(row['createdAt']),
        id: num(row['id'] ?? row['databaseId']),
        title: str(row['title'] ?? row['displayTitle']),
      },
    ];
  });
}

export interface AuditState {
  readonly name: string;
  readonly version: string | undefined;
  readonly kind: string;
  readonly latest: string | undefined;
  readonly tagged: boolean | undefined;
}

/** `scripts/registry-audit.ts --json`'s answer: `ok`, its finding codes, and one state per package. */
export interface AuditDoc {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly states: readonly AuditState[];
}

export function narrowAudit(value: unknown): AuditDoc | undefined {
  const doc = rec(value);
  if (doc === undefined || typeof doc['ok'] !== 'boolean') return undefined;
  const codes = (Array.isArray(doc['findings']) ? doc['findings'] : []).flatMap((one) => {
    const code = rec(one)?.['code'];
    return typeof code === 'string' ? [code] : [];
  });
  const raw = rec(doc['data'])?.['states'];
  const states = (Array.isArray(raw) ? raw : []).flatMap((one) => {
    const state = rec(one);
    const name = str(state?.['name']);
    const kind = str(state?.['kind']);
    if (state === undefined || name === undefined || kind === undefined) return [];
    const tagged = state['tagged'];
    return [
      {
        name,
        kind,
        version: str(state['version']),
        latest: str(state['latest']),
        tagged: typeof tagged === 'boolean' ? tagged : undefined,
      },
    ];
  });
  return { ok: doc['ok'], findings: codes, states };
}

/** A child script's `--json` document: its `ok`, its `data`, and the findings it refused with. */
export interface ChildFinding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
}

export interface ChildDoc {
  readonly ok: boolean;
  readonly data: Readonly<Record<string, unknown>> | undefined;
  readonly findings: readonly ChildFinding[];
}

export function narrowChildDoc(value: unknown): ChildDoc | undefined {
  const doc = rec(value);
  if (doc === undefined || typeof doc['ok'] !== 'boolean') return undefined;
  const findings = (Array.isArray(doc['findings']) ? doc['findings'] : []).flatMap((one) => {
    const finding = rec(one);
    const code = str(finding?.['code']);
    const cause = str(finding?.['cause']);
    const fix = str(finding?.['fix']);
    return code !== undefined && cause !== undefined && fix !== undefined
      ? [{ code, cause, fix }]
      : [];
  });
  return { ok: doc['ok'], data: rec(doc['data']), findings };
}

/** release-due's `data`: the tag it measured and the reason it gave. */
export function narrowReleaseDue(
  value: unknown,
): { readonly lastTag: string | undefined; readonly reason: string | undefined } | undefined {
  const data = rec(value);
  if (data === undefined) return undefined;
  return { lastTag: str(data['lastTag']), reason: str(data['reason']) };
}

/** Open `registry-drift` issues; an entry with no readable number is dropped, never invented. */
export function narrowIssues(value: unknown): readonly AlarmIssue[] {
  return (Array.isArray(value) ? value : []).flatMap((one) => {
    const issue = rec(one);
    const number = num(issue?.['number']);
    if (issue === undefined || number === undefined) return [];
    return [
      {
        number,
        title: str(issue['title']),
        url: str(issue['url']),
        createdAt: str(issue['createdAt']),
        updatedAt: str(issue['updatedAt']),
      },
    ];
  });
}

/** A statusCheckRollup's entries; one with no readable status, conclusion or state is dropped. */
const narrowChecks = (value: unknown): readonly PrCheck[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((one) => {
    const check = rec(one);
    if (check === undefined) return [];
    const status = str(check['status']);
    const conclusion = str(check['conclusion']);
    const state = str(check['state']);
    return status === undefined && conclusion === undefined && state === undefined
      ? []
      : [{ status, conclusion, state }];
  });
};

/** Open Dependabot PRs; an entry with no readable number is dropped, never invented. */
export function narrowPrs(value: unknown): readonly DependabotPr[] {
  return (Array.isArray(value) ? value : []).flatMap((one) => {
    const pr = rec(one);
    const number = num(pr?.['number']);
    if (pr === undefined || number === undefined) return [];
    return [
      {
        number,
        createdAt: str(pr['createdAt']),
        updatedAt: str(pr['updatedAt']),
        url: str(pr['url']),
        state: str(pr['state']),
        autoMerge: 'autoMergeRequest' in pr ? pr['autoMergeRequest'] !== null : undefined,
        checks: narrowChecks(pr['statusCheckRollup']),
      },
    ];
  });
}
