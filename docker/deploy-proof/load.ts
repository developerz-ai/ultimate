// The load half of the deploy proof: mixed GET and POST against the web role's Service for
// LOAD_SECONDS, from inside the cluster, so every request crosses kube-proxy exactly as ingress
// traffic does. Prints one `PROOF {json}` line; run.sh asserts `failed` is 0. Runs as
// `bun -e "$(cat load.ts)"` in a pod on the app image — no file to mount, no second image.
//
// Four kinds in turn per lane: the static page, the health action, a job enqueued through the
// enqueue action and a read of the table v2's migration changes (run.sh's held-job.sh). Each lane
// enqueues under ONE key, so at most one of its jobs is live: the writes are real, the backlog is not.
//
// Each request carries its own client address in X-Forwarded-For, with TRUSTED_PROXY_HOPS=1 in the
// release's secret, because that is what an ingress sends: one pod's address on every request is
// ONE client, and the app's per-client rate limit answers it 429 — a verdict about the harness.

const base = process.env['TARGET'] ?? 'http://proofapp-web';
const end = Date.now() + Number(process.env['LOAD_SECONDS'] ?? '120') * 1000;
const LANES = 8;
const PAUSE_MS = 100;

let total = 0;
let failed = 0;
const reasons: Record<string, number> = {};
const samples: Record<string, string> = {};
const builds: Record<string, number> = {};

const bump = (table: Record<string, number>, key: string): void => {
  table[key] = (table[key] ?? 0) + 1;
};

const fail = (key: string, detail: string): void => {
  failed += 1;
  bump(reasons, key);
  samples[key] ??= detail.slice(0, 160);
};

/** A thrown fetch names its cause by `code` (ECONNRESET) or by `name` (TimeoutError). */
const causeOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'error';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : 'error';
};

/** What a failure is tallied under, by kind: the verb and the route, so a red names its path. */
const KINDS = ['GET /', 'POST health', 'GET proof-attempts', 'POST enqueue-hold'] as const;

/** Request `kind` of lane `index`, in KINDS' order. */
function send(kind: number, index: number, headers: Record<string, string>): Promise<Response> {
  const key = `load-${index}`;
  const json = { ...headers, 'content-type': 'application/json' };
  // `health` is the scaffold's own public action and `/` its static landing page.
  if (kind === 0) return fetch(`${base}/`, { headers });
  if (kind === 1) {
    return fetch(`${base}/api/healths/invoke`, { method: 'POST', headers: json, body: '{}' });
  }
  if (kind === 2) return fetch(`${base}/_x/query/proof-attempts?key=${key}`, { headers });
  const body = JSON.stringify({ key, holdSeconds: 0 });
  return fetch(`${base}/api/holds/enqueue`, { method: 'POST', headers: json, body });
}

async function lane(index: number): Promise<void> {
  for (let i = 0; Date.now() < end; i += 1) {
    const kind = (i + index) % KINDS.length;
    const verb = KINDS[kind] ?? 'unknown';
    const headers = { 'x-forwarded-for': `10.${index}.${(i >> 8) & 255}.${i & 255}` };
    total += 1;
    try {
      const res = await send(kind, index, headers);
      const body = await res.text();
      // core's BUILD_ID_HEADER, spelled out: `bun -e` runs this with no module graph to import from.
      bump(builds, res.headers.get('x-ultimate-build') ?? 'none');
      if (res.status < 200 || res.status > 299) fail(`${verb} ${res.status}`, body);
    } catch (error) {
      fail(`${verb} ${causeOf(error)}`, causeOf(error));
    }
    await Bun.sleep(PAUSE_MS);
  }
}

await Promise.all(Array.from({ length: LANES }, (_, index) => lane(index)));
console.log(`PROOF ${JSON.stringify({ total, failed, reasons, builds, samples })}`);
