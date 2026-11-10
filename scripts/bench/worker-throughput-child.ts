// One worker POD for `worker-throughput.bench.ts`: its own process, its own pool, the shipped
// `jobWorker` over `postgresJobDriver` (slots and poll floor from the bench's profile), a no-op job. Prints `ready` once it claims, and drains on
// SIGTERM. Never run by hand; the bench spawns one per worker it measures.
//
//   bun run scripts/bench/worker-throughput-child.ts --url <postgres url> --concurrency <n> --poll-ms <ms>

import { ctxOf } from '../../packages/core/src/index';
import { postgresClient } from '../../packages/db/src/index';
import { postgresJobDriver } from '../../packages/jobs/src/driver-pg';
import { job } from '../../packages/jobs/src/job';
import { jobWorker } from '../../packages/jobs/src/worker';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
import { benchJobInput, NOOP_JOB } from './worker-throughput-shape';

const args = parseScriptArgs(Bun.argv.slice(2));
const url = args.flags.get('url');
const concurrency = Number(args.flags.get('concurrency'));
const pollIntervalMs = Number(args.flags.get('poll-ms'));
if (typeof url !== 'string' || !(concurrency >= 1) || !(pollIntervalMs >= 1)) {
  throw new ScriptError({
    code: 'X_CLI_BAD_FLAG',
    cause:
      'worker-throughput-child is spawned by the bench with --url, --concurrency and --poll-ms, and was started without them',
    fix: 'bun run scripts/bench/worker-throughput.bench.ts --workers 1',
  });
}

// Named, so the worker resolves it from the registry `job()` writes to — the bench has no app.
job<{ n: number }>({
  name: NOOP_JOB,
  tenant: 'none',
  input: benchJobInput,
  idempotencyKey: (input) => String(input.n),
  retry: { attempts: 1 },
  run: () => Promise.resolve(),
});

const client = postgresClient({ url, role: 'worker' });
const worker = jobWorker({
  driver: postgresJobDriver({
    executor: {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client.query<R>({ text, values }),
    },
  }),
  context: () => ctxOf({ role: 'worker', buildId: 'bench' }),
  concurrency,
  pollIntervalMs,
  // An idle worker re-polls every 250 ms at most rather than backing off to 2 s, so the first claim
  // after the batch lands is not a timer the bench would be measuring instead.
  idlePollMaxMs: Math.max(pollIntervalMs, 250),
  drainOnShutdown: false,
});
worker.start();
// The worker's timers are unrefed (a drained process must be free to exit), so a bare script would
// exit right here: this interval is the pod staying up until SIGTERM.
const alive = setInterval(() => undefined, 60_000);
console.log('ready');

process.on('SIGTERM', () => {
  clearInterval(alive);
  void worker
    .stop()
    .then(() => client.close())
    .finally(() => process.exit(0));
});
