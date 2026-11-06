// The timeline, rendered the way a server renders it: which sentence each event becomes, which
// state the run is in, and that an event's `message` is shown as a detail and never as prose.
import { expect, renderView, unitTest } from '@ultimat3/testing';
import type { RunEventRow } from './run-state';
import type { RunTimelineProps } from './run-view';
import { RunTimeline, runOutput } from './run-view';

const RUN = '00000000-0000-4000-8000-0000000000b1';
const USED = {
  browserMs: 4250,
  navigations: 2,
  httpRequests: 1,
  bytesIn: 2048,
  promptsAnswered: 1,
};

const event = (seq: number, kind: RunEventRow['kind'], message = ''): RunEventRow => ({
  id: `event-${seq}`,
  runId: RUN,
  seq,
  kind,
  at: '2026-10-01T09:00:00.000Z',
  message,
  prompt: kind === 'prompt' ? 1 : null,
  usage: kind === 'usage' ? USED : null,
});

const props = (events: readonly RunEventRow[]): RunTimelineProps => ({
  events,
  locale: 'en',
  zone: 'Asia/Tokyo',
  labels: {
    states: {
      pending: 'Waiting to start',
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
      done: 'Done',
      failed: 'Stopped',
    },
    busy: 'Another run holds this connection',
    usage: {
      heading: 'What the run used',
      browser: 'Browser time',
      navigations: 'Pages opened',
      requests: 'Requests',
      bytes: 'Data read',
      prompts: 'Codes answered',
      raw: 'Usage record',
    },
    events: 'Run events',
    output: 'Run output',
    accounts: { locale: 'en', forms: { one: '{count} account', other: '{count} accounts' } },
  },
});

const render = async (events: readonly RunEventRow[]): Promise<string> =>
  (await renderView(RunTimeline, props(events))).html;

unitTest('a run with no event yet is pending, and lists nothing', async () => {
  const html = await render([]);
  expect(html).toContain('data-state="pending"');
  expect(html).toContain('Waiting to start');
  expect(html.match(/data-kind=/g)).toBeNull();
});

unitTest('each event is one row, numbered by its seq, worded by its kind', async () => {
  const html = await render([event(1, 'prompt', 'one-time code'), event(2, 'answered')]);
  expect(html.match(/data-kind=/g)).toHaveLength(2);
  expect(html).toContain('data-key="1"');
  expect(html).toContain('The site asked for a code');
  expect(html).toContain('data-state="streaming"');
  // The site's own label is a detail the console does not print: the sentence is the catalog's.
  expect(html).not.toContain('one-time code');
});

unitTest('a waiting run says it is waiting', async () => {
  const html = await render([event(1, 'prompt')]);
  expect(html).toContain('data-state="awaiting"');
  expect(html).toContain('Waiting for your code');
});

unitTest('a failed run shows the code it failed with', async () => {
  const html = await render([event(1, 'prompt'), event(2, 'failed', 'X_SCRAPE_PROMPT_UNANSWERED')]);
  expect(html).toContain('data-state="failed"');
  expect(html).toContain('<code');
  expect(html).toContain('X_SCRAPE_PROMPT_UNANSWERED');
});

unitTest('a refused run says the connection was busy, in words and not as a code', async () => {
  const html = await render([event(1, 'failed', 'X_JOB_KEY_BUSY')]);
  expect(html).toContain('data-state="failed"');
  expect(html).toContain('Another run holds this connection');
  expect(html).not.toContain('X_JOB_KEY_BUSY');
});

unitTest(
  'the transcript says what the timeline says, a stop in red and a busy one in words',
  () => {
    const labels = props([]).labels;
    const busy = runOutput([event(1, 'navigated'), event(2, 'failed', 'X_JOB_KEY_BUSY')], labels);
    expect(busy).toBe(
      '  1 Opened the accounts page\n\u001b[31m  2 Stopped: Another run holds this connection\u001b[0m',
    );
    const done = runOutput([event(1, 'done', '3'), event(2, 'usage')], labels);
    expect(done).toBe('  1 Done: 3 accounts');
  },
);

unitTest('what a run used is one block after its events, never a row of them', async () => {
  const html = await render([event(1, 'navigated'), event(2, 'done', '2'), event(3, 'usage')]);
  expect(html.match(/data-kind=/g)).toHaveLength(2);
  expect(html).toContain('data-role="run-usage"');
  expect(html).toContain('What the run used');
  // Seconds and kilobytes, in the member's locale: 4,250 ms and 2,048 B.
  expect(html).toContain('4.3');
  expect(html).toContain('2 kB');
  expect(await render([event(1, 'done', '2')])).not.toContain('data-role="run-usage"');
});

unitTest(
  'a finished run says how many accounts it read, in the plural the count takes',
  async () => {
    expect(await render([event(1, 'done', '2')])).toContain('2 accounts');
    expect(await render([event(1, 'done', '1')])).toContain('1 account<');
  },
);

unitTest('an instant is formatted in the zone it was handed, never the machine’s', async () => {
  // 09:00 UTC is 18:00 in Tokyo.
  expect(await render([event(1, 'navigated')])).toContain('6:00:00');
});
