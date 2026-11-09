// The effect log a simulated run is judged by: row writes, mail, calls out and enqueues, each
// attributed to the worker whose body made it — reads and process reports are not effects, and one
// made after its worker died is dropped. Every borrowed seam is chained onto what was installed and
// handed back; the rows are a bus subscription (`entity.row`/`entity.bulk`), released at dispose.

import type { AsyncContext } from '@ultimat3/core';
import {
  asyncContext,
  configureErrorReporting,
  installedErrorReporter,
  noopErrorReporter,
  subscribe,
} from '@ultimat3/core';
import type { MailDriver } from '@ultimat3/mail';

export interface SimEffect {
  /** `row:posts:insert`, `mail:receipt→a@x.example`, `network:POST api.example/v1/charges`. */
  readonly key: string;
  /** The worker whose body made it; absent for the harness. */
  readonly worker?: string;
  /** The last step that worker's run had COMPLETED when the effect happened. */
  readonly after?: string;
  /** The step whose body made it (`@ultimat3/jobs`' `currentStep()`); absent between steps. */
  readonly inside?: string;
}

export interface EffectLog extends AsyncDisposable {
  /** The worker a call in flight belongs to: what `run` scoped it to. */
  readonly scope: AsyncContext<string>;
  record(key: string): void;
  /** A worker's run completed this step — what the next effect it makes is placed after. */
  stepWritten(worker: string, step: string): void;
  effects(): readonly SimEffect[];
  clear(): void;
}

export interface EffectLogOptions {
  readonly isDead: (worker: string) => boolean;
}

const hostAndPath = (url: string): string => {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
};

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  (
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();

export async function openEffectLog(options: EffectLogOptions): Promise<EffectLog> {
  const { currentStep } = await import('@ultimat3/jobs');
  const mail = await import('@ultimat3/mail');
  const scope = asyncContext<string>('the job simulation');
  const log: SimEffect[] = [];
  const lastStep = new Map<string, string>();

  const record = (key: string): void => {
    const worker = scope.get();
    if (worker !== undefined && options.isDead(worker)) return;
    const after = worker === undefined ? undefined : lastStep.get(worker);
    const inside = currentStep();
    log.push({
      key,
      ...(worker === undefined ? {} : { worker }),
      ...(after === undefined ? {} : { after }),
      ...(inside === undefined ? {} : { inside }),
    });
  };

  const offRows = subscribe('entity', (event) => {
    if (event.name === 'entity.row') record(`row:${event.payload.entity}:${event.payload.op}`);
    if (event.name !== 'entity.bulk') return;
    const { entity, op } = event.payload;
    for (let i = 0; i < event.payload.rows; i += 1) record(`row:${entity}:${op}`);
  });

  // A send with no mail driver installed is answered by an in-memory one: the effect is the send.
  const previousMail = mail.tryMailDriver();
  const deliver = previousMail ?? mail.memoryMailDriver();
  const recording: MailDriver = {
    name: deliver.name,
    send: async (message) => {
      const sent = await deliver.send(message);
      record(`mail:${message.mailId}→${message.to.join(',')}`);
      return sent;
    },
  };
  mail.setMailDriver(recording);

  // Set aside, never chained: a report is the process telling its operator, not the body acting.
  // An app's sink keeps state across runs (`errorGroupsSink` enqueues on a group's FIRST sighting),
  // so chained, whichever simulated run reported first would carry its enqueue and every other
  // run's count would differ — and a death planted here would land in the app's own error store.
  const previousReporter = installedErrorReporter();
  configureErrorReporting({ reporter: noopErrorReporter });

  // Recorded on the way out, then handed to whatever `fetch` is installed — the seal decides.
  const previousFetch = globalThis.fetch;
  const recordingFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    record(`network:${methodOf(input, init)} ${hostAndPath(urlOf(input))}`);
    return previousFetch(input, init);
  };
  globalThis.fetch = Object.assign(recordingFetch, previousFetch);

  return {
    scope,
    record,
    stepWritten: (worker, step) => {
      lastStep.set(worker, step);
    },
    effects: () => [...log],
    clear: () => {
      log.length = 0;
      lastStep.clear();
    },
    [Symbol.asyncDispose]: async (): Promise<void> => {
      // Each restore runs whatever the one before it did: a throw must not strand a seam.
      try {
        globalThis.fetch = previousFetch;
      } finally {
        configureErrorReporting({ reporter: previousReporter });
        if (previousMail === undefined) mail.resetMailDriver();
        else mail.setMailDriver(previousMail);
        offRows();
      }
    },
  };
}

/** How many times each key happened. */
export function effectCounts(effects: readonly SimEffect[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const effect of effects) counts.set(effect.key, (counts.get(effect.key) ?? 0) + 1);
  return counts;
}
