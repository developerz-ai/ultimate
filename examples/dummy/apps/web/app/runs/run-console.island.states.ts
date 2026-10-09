/**
 * The states the run console can be photographed in — the five a run goes through, the refusal a
 * busy connection answers, and the two screens before one: no connection yet, and a connection
 * with no run started.
 *
 * None of the five can be held still by clicking: each lasts as long as the job takes to write its
 * next event. And the shot harness refuses `WebSocket` outright, so a live subscription could not
 * be photographed at all — hence `preview`, the events drawn as props. The page passes none.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The label strings are literals here and that is not a `t()` violation: an island's props cross
 * the seam as JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { RunConsoleProps } from './run-console.island';

const RUN = {
  runId: '00000000-0000-4000-8000-0000000000b1',
  jobId: '00000000-0000-4000-8000-0000000000e1',
};

type Preview = NonNullable<RunConsoleProps['preview']>[number];

const event = (seq: number, kind: Preview['kind'], message = ''): Preview => ({
  id: `00000000-0000-4000-8000-00000000f${String(seq).padStart(3, '0')}`,
  runId: RUN.runId,
  seq,
  kind,
  at: `2026-10-01T09:00:${String(seq).padStart(2, '0')}.000Z`,
  message,
  prompt: kind === 'prompt' ? 1 : null,
  usage: null,
});

/** What a recorded run of the ledger uses: two pages, one API read, one code. */
const used = (seq: number): Preview => ({
  ...event(seq, 'usage'),
  usage: { browserMs: 4200, navigations: 2, httpRequests: 1, bytesIn: 2048, promptsAnswered: 1 },
});

const BASE = {
  orgId: '00000000-0000-4000-8000-0000000000aa',
  locale: 'en',
  zone: 'Asia/Tokyo',
  connections: [{ id: '00000000-0000-4000-8000-0000000000d1', label: 'Ledger' }],
  labels: {
    states: {
      pending: 'Waiting for the run to start',
      streaming: 'Running',
      awaiting: 'Waiting for your code',
      failed: 'The run failed',
      done: 'Finished',
    },
    kinds: {
      prompt: 'The site asked for a code',
      answered: 'Code received',
      navigated: 'Opened the accounts page',
      extracted: 'Read the accounts',
      done: 'Finished',
      failed: 'Stopped',
    },
    busy: 'Another run is already active on this connection. Start this one again when it ends.',
    usage: {
      heading: 'What the run used',
      browser: 'Browser time',
      navigations: 'Pages opened',
      requests: 'Requests',
      bytes: 'Data read',
      prompts: 'Codes answered',
    },
    events: 'Run events',
    accounts: {
      locale: 'en',
      forms: { one: '{count} account read', other: '{count} accounts read' },
    },
    connection: 'Connection',
    start: 'Start run',
    cancel: 'Cancel run',
    idle: 'No run yet. Start one to watch it here.',
    connectHeading: 'Connect a site',
    connectName: 'Name',
    connectCredential: 'Password',
    connectSubmit: 'Connect',
    promptLabel: 'One-time code',
    promptSubmit: 'Send code',
    faults: {
      connect: 'The site could not be connected. Try again.',
      start: 'The run could not be started. Try again.',
      answer: 'The code could not be sent. Try again.',
      cancel: 'The run could not be cancelled. Try again.',
    },
  },
  ui: {
    locale: 'en',
    catalog: {
      'ui.empty': 'Nothing here yet',
      'ui.error.title': 'Something went wrong',
      'ui.retry': 'Try again',
    },
  },
} satisfies RunConsoleProps;

export const runConsoleStates = defineIslandStates({
  island: 'apps/web/app/runs/run-console.island.tsx',
  viewport: { width: 720, height: 520 },
  states: [
    {
      id: 'no-connection',
      title: 'an org that has connected no site yet',
      note: 'the connect form stands where the picker will: there is nothing to start a run on',
      props: { ...BASE, connections: [] },
    },
    {
      id: 'idle',
      title: 'a connection picked and no run started',
      props: BASE,
    },
    {
      id: 'pending',
      title: 'a run that is queued and has written no event',
      note: 'lasts until a worker claims the job',
      props: { ...BASE, run: RUN, preview: [] },
    },
    {
      id: 'streaming',
      title: 'a run past its prompt, reading the site',
      props: {
        ...BASE,
        run: RUN,
        preview: [event(1, 'prompt', 'one-time code'), event(2, 'answered'), event(3, 'navigated')],
      },
    },
    {
      id: 'awaiting-input',
      title: 'a run stopped on the site’s question, its browser open',
      note: 'the one state with a form in it: the answer resumes the run',
      props: { ...BASE, run: RUN, preview: [event(1, 'prompt', 'one-time code')] },
    },
    {
      id: 'failed',
      title: 'a run nobody answered in time',
      props: {
        ...BASE,
        run: RUN,
        preview: [
          event(1, 'prompt', 'one-time code'),
          event(2, 'failed', 'X_SCRAPE_PROMPT_UNANSWERED'),
        ],
      },
    },
    {
      id: 'refused',
      title: 'a run started while another held its connection',
      note: 'one run per connection: the queue refused it before its body ran, so it used nothing',
      props: { ...BASE, run: RUN, preview: [event(1, 'failed', 'X_JOB_KEY_BUSY')] },
    },
    {
      id: 'done',
      title: 'a run that read the accounts, ended, and said what it used',
      props: {
        ...BASE,
        run: RUN,
        preview: [
          event(1, 'prompt', 'one-time code'),
          event(2, 'answered'),
          event(3, 'navigated'),
          event(4, 'extracted', '2'),
          event(5, 'done', '2'),
          used(6),
        ],
      },
    },
  ],
});
