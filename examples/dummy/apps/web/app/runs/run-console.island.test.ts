// The console the browser actually runs: `mountIsland` builds the chunk `x build` builds — the
// realtime bootstrap included — and drives `mount` against a micro-DOM, with a fake `WebSocket`
// in place of a sync node and a `fetch` that answers what a server would.
//
// What it proves: starting a run posts through the page's one transport, the console then
// subscribes to `liveRunEvents` BY NAME for the run it was answered, events the node sends appear
// without a reload, and the prompt's answer names that run.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { Frame } from '@ultimat3/realtime';
import { decode, encode, installRealtime, PROTOCOL_VERSION } from '@ultimat3/realtime';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  renderView,
  test,
} from '@ultimat3/testing';
import type { RunConsoleProps } from './run-console.island';
import { RunConsole } from './run-console.island';
import { runConsoleStates } from './run-console.island.states';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SYNC_URL = 'ws://localhost:3001';
const RUN = { runId: '00000000-0000-4000-8000-0000000000b7', jobId: 'job-7' };

/** The page state every island bundle on a page shares — `globalThis`, by its registered symbol. */
const PAGE = Symbol.for('ultimate.realtime');

/** One turn of the event loop: the transport's answer and the socket's dial are awaits deep. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const opened: FakeSocket[] = [];

/** The `WebSocket` the chunk constructs. Only what the page socket touches. */
class FakeSocket {
  readonly url: string;
  readonly sent: string[] = [];
  readonly bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    opened.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({ code: 1000 });
  }

  deliver(frame: Frame): void {
    this.onmessage?.({ data: encode(frame) });
  }

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

/** Every request the island made, and the one answer each path gets. */
const calls: { readonly url: string; readonly body: unknown }[] = [];
const answers: Readonly<Record<string, unknown>> = {
  '/api/runs/start': RUN,
  '/api/prompts/answer': { runId: RUN.runId, prompt: 1 },
  '/api/runs/cancel': { runId: RUN.runId },
};
const serverFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(url), 'http://dev.test').pathname;
  calls.push({ url: path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
  return Promise.resolve(Response.json(answers[path] ?? {}));
};

/** The props a declared state hands the island, as the island's own type. */
const propsOf = (id: string): RunConsoleProps => {
  const state = runConsoleStates.states.find((one) => one.id === id);
  if (state === undefined) return expect.unreachable(`the manifest declares no "${id}" state`);
  // The manifest types every state's props as a JSON record; this file reads them as the island's.
  return state.props as unknown as RunConsoleProps;
};
const IDLE = propsOf('idle');

const mountState = (id: string): Promise<MountedIsland> =>
  mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: runConsoleStates.island,
    props: propsOf(id),
    shell: '<div data-role="shell">Loading</div>',
    globals: { WebSocket: FakeSocket, fetch: serverFetch },
  });

let mounted: MountedIsland;
const dispose = (): void => {
  mounted?.[Symbol.dispose]();
};

beforeAll(() => {
  // Where the page's socket dials. A real document names it in `<head>`; the micro-DOM has none.
  installRealtime({
    signal: <T>(initial: T): [() => T, (next: T) => void] => {
      let held = initial;
      return [() => held, (next) => (held = next)];
    },
    sync: { url: SYNC_URL, buildId: 'build-1' },
  });
});

afterAll(() => {
  // The page state is process-global: left behind it would be the next file's page.
  Reflect.deleteProperty(globalThis, PAGE);
});

describe('the run console island, with a connection and no run', () => {
  beforeAll(async () => {
    mounted = await mountState('idle');
    await settle();
  }, 60_000);
  afterAll(dispose);

  test('mount replaces the shell with the picker, and opens no socket for no run', () => {
    expect(mounted.find('[data-role="shell"]')).toBeNull();
    expect(mounted.text('[id="run-start"]')).toBe('Start run');
    expect(mounted.text('[data-role="idle"]')).toBe('No run yet. Start one to watch it here.');
    expect(opened).toHaveLength(0);
    // Solid compiles to real DOM calls; a chunk that fell back to the classic React factory names
    // a global that is not in it.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    // The transport is the page's: the chunk names no `fetch(` of its own making a request.
    expect(mounted.code).not.toContain('XMLHttpRequest');
  });

  test('start posts the picked connection and subscribes to the run it is answered', async () => {
    expect(mounted.fire('[id="run-start"]', 'click')).toBe(true);
    for (let tick = 0; tick < 20 && opened.length === 0; tick += 1) await settle();

    expect(calls.at(-1)).toEqual({
      url: '/api/runs/start',
      body: { orgId: IDLE.orgId, connectionId: IDLE.connections[0]?.id },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.url.startsWith(SYNC_URL)).toBe(true);
    opened[0]?.onopen?.();
    await settle();
    const subscribe = opened[0]?.frames().find((frame) => frame.type === 'subscribe');
    expect(subscribe?.type === 'subscribe' ? subscribe.target : undefined).toMatchObject({
      kind: 'query',
      qid: 'liveRunEvents',
      input: { orgId: IDLE.orgId, runId: RUN.runId },
    });
  });

  test('events the node sends appear without a reload, and a prompt opens the form', async () => {
    const subscribe = opened[0]?.frames().find((frame) => frame.type === 'subscribe');
    const sid = subscribe?.type === 'subscribe' ? subscribe.sid : '';
    opened[0]?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows: [
        {
          id: 'e1',
          runId: RUN.runId,
          seq: 1,
          kind: 'prompt',
          at: '2026-10-01T09:00:01.000Z',
          message: 'one-time code',
          prompt: 1,
          usage: null,
        },
      ],
      cursor: { qid: 'q', lsn: '1', ids: ['e1'], at: 0 },
      entity: 'run_events',
    });
    await settle();

    expect(mounted.all('li')).toHaveLength(1);
    expect(mounted.text('[data-role="run-state"]')).toBe('Waiting for your code');
    expect(mounted.find('[data-role="prompt"]')).not.toBeNull();
  });

  test('the answer names the run and the prompt it is for', async () => {
    const code = mounted.find('input[aria-label="One-time code"]');
    expect(code).not.toBeNull();
    if (code !== null) code.value = '482913';
    expect(mounted.fire(code, 'input')).toBe(true);
    expect(mounted.fire('[data-role="prompt"]', 'submit', { preventDefault: () => {} })).toBe(true);
    await settle();
    await settle();

    expect(calls.at(-1)).toEqual({
      url: '/api/prompts/answer',
      body: { orgId: IDLE.orgId, runId: RUN.runId, prompt: 1, answer: '482913' },
    });
  });

  test('cancel names the run the start answered', async () => {
    expect(mounted.fire('[id="run-cancel"]', 'click')).toBe(true);
    await settle();
    await settle();
    expect(calls.at(-1)).toEqual({
      url: '/api/runs/cancel',
      body: { orgId: IDLE.orgId, runId: RUN.runId },
    });
  });
});

describe('the run console island, finished', () => {
  beforeAll(async () => {
    mounted = await mountState('done');
    await settle();
  }, 60_000);
  afterAll(dispose);

  test('every event is a row in seq order, and the run says how many accounts it read', () => {
    expect(mounted.all('li').map((row) => row.getAttribute('data-seq'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(mounted.text('[data-role="run-state"]')).toBe('Finished');
    expect(mounted.text('[data-role="run-summary"]')).toBe('2 accounts read');
    // What it used is its own block, never a step of the run.
    expect(mounted.find('[data-role="run-usage"]')).not.toBeNull();
    // A run that ended has nothing to answer and nothing to cancel.
    expect(mounted.find('[data-role="prompt"]')).toBeNull();
    expect(mounted.find('[id="run-cancel"]')).toBeNull();
  });
});

describe('the run console island, with no connection', () => {
  beforeAll(async () => {
    mounted = await mountState('no-connection');
    await settle();
  }, 60_000);
  afterAll(dispose);

  test('the connect form stands where the picker will', () => {
    expect(mounted.find('[data-role="connect"]')).not.toBeNull();
    expect(mounted.find('[id="run-start"]')).toBeNull();
    expect(mounted.find('input[type="password"]')).not.toBeNull();
  });
});

// The SAME component, rendered on the server from each declared state: what the document carries
// for a state, with no chunk built. The mounts above prove the browser half; this proves every
// declared state draws the screen its title claims, and runs the island's own source.
describe('every declared state of the run console', () => {
  const html = async (id: string): Promise<string> =>
    (await renderView(RunConsole, propsOf(id))).html;

  test('the manifest declares the five run states, the refusal, and the screens before a run', () => {
    expect(runConsoleStates.states.map((state) => state.id)).toEqual([
      'no-connection',
      'idle',
      'pending',
      'streaming',
      'awaiting-input',
      'failed',
      'refused',
      'done',
    ]);
  });

  test('no-connection draws the connect form and no picker', async () => {
    const drawn = await html('no-connection');
    expect(drawn).toContain('data-role="connect"');
    expect(drawn).not.toContain('id="run-start"');
  });

  test('idle draws the picker and says there is no run yet', async () => {
    const drawn = await html('idle');
    expect(drawn).toContain('id="run-start"');
    expect(drawn).toContain('data-role="idle"');
    expect(drawn).not.toContain('data-role="run"');
  });

  test('pending, streaming and awaiting-input are live runs: each can be cancelled', async () => {
    for (const [id, state] of [
      ['pending', 'pending'],
      ['streaming', 'streaming'],
      ['awaiting-input', 'awaiting'],
    ] as const) {
      const drawn = await html(id);
      expect(drawn).toContain(`data-state="${state}"`);
      expect(drawn).toContain('id="run-cancel"');
    }
  });

  test('only awaiting-input draws the prompt form', async () => {
    expect(await html('awaiting-input')).toContain('data-role="prompt"');
    expect(await html('streaming')).not.toContain('data-role="prompt"');
    expect(await html('pending')).not.toContain('data-role="prompt"');
  });

  test('failed and done are ended runs: nothing to answer, nothing to cancel', async () => {
    for (const id of ['failed', 'done']) {
      const drawn = await html(id);
      expect(drawn).toContain(`data-state="${id}"`);
      expect(drawn).not.toContain('id="run-cancel"');
      expect(drawn).not.toContain('data-role="prompt"');
    }
    expect(await html('failed')).toContain('X_SCRAPE_PROMPT_UNANSWERED');
  });

  test('refused says the connection was busy, in words, and is an ended run', async () => {
    const drawn = await html('refused');
    expect(drawn).toContain('data-state="failed"');
    expect(drawn).toContain('data-role="run-busy"');
    expect(drawn).toContain('Another run is already active on this connection');
    expect(drawn).not.toContain('<code');
    expect(drawn).not.toContain('id="run-cancel"');
  });

  test('done draws what the run used, and nothing that has not ended does', async () => {
    const drawn = await html('done');
    expect(drawn).toContain('data-role="run-usage"');
    expect(drawn).toContain('Pages opened');
    expect(drawn).toContain('4.2');
    for (const id of ['pending', 'streaming', 'awaiting-input', 'failed', 'refused']) {
      expect(await html(id)).not.toContain('data-role="run-usage"');
    }
  });
});
