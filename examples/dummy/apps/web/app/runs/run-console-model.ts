/**
 * What the console holds and does, with no markup in it: which connection is picked, which run
 * is being followed, and the four writes — each through the typed browser client, the page's one
 * transport. The island draws this; a test drives it with a client that answers what it is told.
 *
 * A write that fails names WHICH write failed and nothing else: the reason is the server's, and
 * the console's job is to say what did not happen so the person can do it again.
 */

import { isSuperseded } from '@ultimat3/core/page';
import { createSignal } from 'solid-js';
import type { browserClient } from '../../shared/browser-client';

/** The handle `startRun` answered: what the events are keyed by and a cancel names. */
export type RunHandle = { readonly runId: string; readonly jobId: string };

export type ConnectionOption = { readonly id: string; readonly label: string };

/** The write that did not happen. One at a time: the next attempt clears it. */
export type ConsoleFault = 'connect' | 'start' | 'answer' | 'cancel';

/** The four calls the console makes — the typed client's own methods: a rename is a build error. */
export type ConsoleClient = Pick<
  typeof browserClient,
  'connectSite' | 'startRun' | 'answerPrompt' | 'cancelRun'
>;

export interface ConsoleSeed {
  readonly orgId: string;
  readonly connections: readonly ConnectionOption[];
  /** A run to show from the first paint. The page passes none; the states file does. */
  readonly run?: RunHandle | undefined;
}

export interface ConsoleModel {
  connections(): readonly ConnectionOption[];
  selected(): string;
  run(): RunHandle | null;
  fault(): ConsoleFault | null;
  busy(): boolean;
  select(connectionId: string): void;
  connect(label: string, credential: string): Promise<void>;
  start(): Promise<void>;
  answer(prompt: number, code: string): Promise<void>;
  cancel(): Promise<void>;
}

export function createConsole(seed: ConsoleSeed, client: ConsoleClient): ConsoleModel {
  const [connections, setConnections] = createSignal(seed.connections);
  const [selected, setSelected] = createSignal(seed.connections[0]?.id ?? '');
  const [run, setRun] = createSignal<RunHandle | null>(seed.run ?? null);
  const [fault, setFault] = createSignal<ConsoleFault | null>(null);
  const [busy, setBusy] = createSignal(false);

  const attempt = async (what: ConsoleFault, write: () => Promise<void>): Promise<void> => {
    setFault(null);
    setBusy(true);
    try {
      await write();
    } catch (error) {
      // The page changed principal mid-write: the answer is for somebody who is gone.
      if (!isSuperseded(error)) setFault(what);
    } finally {
      setBusy(false);
    }
  };

  return {
    connections,
    selected,
    run,
    fault,
    busy,
    select: (connectionId) => {
      setSelected(connectionId);
    },
    connect: (label, credential) =>
      attempt('connect', async () => {
        const made = await client.connectSite({ orgId: seed.orgId, label, credential });
        setConnections([{ id: made.id, label: made.label }, ...connections()]);
        setSelected(made.id);
      }),
    start: () =>
      attempt('start', async () => {
        const started = await client.startRun({ orgId: seed.orgId, connectionId: selected() });
        setRun({ runId: started.runId, jobId: started.jobId });
      }),
    answer: (prompt, code) =>
      attempt('answer', async () => {
        const current = run();
        if (current === null) return;
        await client.answerPrompt({
          orgId: seed.orgId,
          runId: current.runId,
          prompt,
          answer: code,
        });
      }),
    cancel: () =>
      attempt('cancel', async () => {
        const current = run();
        if (current === null) return;
        await client.cancelRun({ orgId: seed.orgId, runId: current.runId });
      }),
  };
}
