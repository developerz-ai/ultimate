// The regression set for `x docs`' ranking: task questions an adopter's agent actually asked, each
// with the topic prefixes a right answer starts with. Scored in `docs-search.test.ts` over the real
// installed tree and the shipped wiki; the floor there is the promise, this list is the evidence.

export interface DocsEvalCase {
  readonly question: string;
  /**
   * A hit is right when its topic equals one of these or starts with it plus `.` or `#`, so `mail`
   * accepts `mail.mail` and `mail.README#…`, and `wiki.Upgrading` accepts every Upgrading section.
   */
  readonly wanted: readonly string[];
}

/** How many of the top hits a question may look through. An agent reads about three. */
export const EVAL_TOP = 3;

/** Measured 11 of 20 on a scaffold's installed tree before plan 101 slice 32 (2026-11-02). */
export const EVAL_FLOOR = 18;

export const DOCS_EVAL_SET: readonly DocsEvalCase[] = [
  { question: 'send email', wanted: ['mail'] },
  { question: 'upload a file to s3', wanted: ['storage'] },
  { question: 'upgrade to the next major', wanted: ['wiki.Upgrading'] },
  { question: 'upgrade 28', wanted: ['wiki.Upgrading#28x--2900-entry-by-entry'] },
  { question: 'scrape a website', wanted: ['scraping', 'wiki.Scraping'] },
  { question: 'streaming llm agent', wanted: ['ai', 'wiki.MCP-And-AI'] },
  { question: 'feature flag', wanted: ['flags', 'wiki.Feature-Flags'] },
  { question: 'format money in a currency', wanted: ['money', 'wiki.Money'] },
  { question: 'send a push notification', wanted: ['notify', 'pwa', 'wiki.Notify'] },
  { question: 'retry a failed job', wanted: ['jobs', 'wiki.Jobs-And-Workflows'] },
  { question: 'schedule a recurring task', wanted: ['jobs', 'wiki.Scheduled-Tasks'] },
  { question: 'check a permission', wanted: ['policy', 'wiki.Policies-And-Authz'] },
  { question: 'sign in with a password', wanted: ['auth', 'wiki.Auth'] },
  { question: 'live updates over websocket', wanted: ['realtime', 'wiki.Realtime'] },
  { question: 'offline service worker', wanted: ['pwa', 'wiki.PWA-And-Offline'] },
  { question: 'expose a tool to an mcp client', wanted: ['mcp', 'wiki.MCP-And-AI'] },
  { question: 'format a date in a time zone', wanted: ['time', 'wiki.Timezones-And-Dates'] },
  { question: 'graceful drain on sigterm', wanted: ['wiki.Deployment'] },
  { question: 'translate a string', wanted: ['i18n', 'wiki.I18n'] },
  { question: 'write a test for an action', wanted: ['testing', 'action', 'wiki.Testing'] },
];

/** True when `topic` is one of `wanted` or a topic under one of them. */
export function isWanted(topic: string, wanted: readonly string[]): boolean {
  return wanted.some(
    (prefix) =>
      topic === prefix || topic.startsWith(`${prefix}.`) || topic.startsWith(`${prefix}#`),
  );
}
