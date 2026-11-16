// The `roadmap` step's tracker rule: a `docs/plans/**/status.yml` reading `in_progress` whose
// directory no commit has touched for more than STALE_PLAN_DAYS is X_ROADMAP_TRACKER_STALE. Two
// live trackers once sat beside the real one for weeks, one still saying "Next: 31.22.1"; a
// tracker nobody works must be closed (`superseded`, pointing at its successor), not left to read as live.

// why: host-separator paths into the checkout; Bun ships no path API.
import { join, posix } from 'node:path';
import { PLAN_STATUS_GLOB } from '../plan-status';
import type { Finding } from './log';
import { git } from './release-due-git';

/** Days a tracker may sit `in_progress` with no commit in its directory. Plan 101b slice 12, M1. */
export const STALE_PLAN_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * The newest commit touching a directory. `boundary` marks a shallow clone's graft commit, which
 * git reports as touching every path: its date is only an UPPER bound on the real last touch.
 */
export interface LastTouch {
  readonly at: number;
  readonly boundary: boolean;
}

export interface StaleDeps {
  /** Epoch milliseconds. Injected: a test never reads the wall clock. */
  readonly now: () => number;
  /** `undefined` when git cannot answer: not a repository, or a directory never committed. */
  readonly lastTouch: (root: string, dir: string) => Promise<LastTouch | undefined>;
}

/** `git log -1` over `dir`: committer time, and whether that commit is a shallow boundary. */
export async function gitLastTouch(root: string, dir: string): Promise<LastTouch | undefined> {
  const asked = await git(['log', '-1', '--format=%ct %P', '--', dir], root);
  if (!asked.ok) return undefined;
  const [seconds, ...parents] = asked.output.trim().split(/\s+/);
  const at = Number(seconds) * 1000;
  if (seconds === undefined || seconds === '' || !Number.isFinite(at)) return undefined;
  if (parents.length > 0) return { at, boundary: false };
  const shallow = await git(['rev-parse', '--is-shallow-repository'], root);
  return { at, boundary: shallow.ok && shallow.output.trim() === 'true' };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The template's `last_updated: <YYYY-MM-DD>`, as UTC midnight; anything else is no date. */
const lastUpdated = (doc: Readonly<Record<string, unknown>>): number | undefined => {
  const raw = doc['last_updated'];
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const at = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(at) ? at : undefined;
};

interface Dated {
  readonly at: number;
  readonly source: string;
}

/**
 * When the tracker was last worked. A real commit is the answer. A shallow boundary only bounds
 * it from above, so the tracker's own `last_updated` dates it when older; neither, no answer.
 */
const datedBy = (touch: LastTouch, doc: Readonly<Record<string, unknown>>): Dated => {
  if (!touch.boundary) return { at: touch.at, source: 'commit touching it' };
  const claimed = lastUpdated(doc);
  return claimed !== undefined && claimed < touch.at
    ? { at: claimed, source: 'last_updated' }
    : { at: touch.at, source: 'commit a shallow clone holds (an upper bound)' };
};

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

const staleFinding = (path: string, dir: string, days: number, dated: Dated): Finding => ({
  code: 'X_ROADMAP_TRACKER_STALE',
  cause: `${path} reads status: in_progress, but nothing has touched ${dir} for ${String(days)} days (last ${dated.source}: ${day(dated.at)} UTC), past the ${String(STALE_PLAN_DAYS)}-day limit — a tracker nobody works reads as live work`,
  fix: `bun run scripts/roadmap.ts --json   # after editing ${path}: set status: superseded and a current_focus naming the plan that carries its open rows (or status: complete) — or commit the work that moves it`,
  at: path,
});

/** Every `in_progress` tracker under `root` untouched for more than STALE_PLAN_DAYS. */
export async function stalePlanFindings(root: string, deps: StaleDeps): Promise<Finding[]> {
  const paths = (await Array.fromAsync(new Bun.Glob(PLAN_STATUS_GLOB).scan({ cwd: root })))
    .map((path) => path.split('\\').join('/'))
    .sort();
  const findings: Finding[] = [];
  const now = deps.now();
  for (const path of paths) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(await Bun.file(join(root, path)).text());
    } catch {
      continue; // broken YAML is X_PLAN_STATUS_INVALID, `plan-status`'s finding
    }
    if (!isRecord(doc) || doc['status'] !== 'in_progress') continue;
    const dir = posix.dirname(path);
    const touch = await deps.lastTouch(root, dir);
    if (touch === undefined) continue;
    const dated = datedBy(touch, doc);
    const days = Math.floor((now - dated.at) / DAY_MS);
    if (now - dated.at > STALE_PLAN_DAYS * DAY_MS) {
      findings.push(staleFinding(path, dir, days, dated));
    }
  }
  return findings;
}
