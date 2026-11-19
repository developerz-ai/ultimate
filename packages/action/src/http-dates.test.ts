// An action's `Date` output over the real pipeline: the plain 200, the enveloped 200 and the
// streamed `done` frame each name their instants (`x-ultimate-dates`, the read projection's rule),
// so the typed client hands back the `Date` the output type promises. The body stays the ISO text.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  DATES_HEADER,
  installLogSink,
  RECORDS_HEADER,
  reviveWireDates,
  userActor,
  wireDatePaths,
} from '@ultimat3/core';
import { clearRegistry, entity, timestamp, uuid } from '@ultimat3/entity';
import { defineHttpConfig, httpServer, WIRE_DATES_MAX_BYTES } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import type { FetchLike } from './client';
import { toRoute } from './http';

const AT = new Date('2026-03-04T05:06:07.089Z');
const ID = '00000000-0000-7000-8000-0000000000aa';

const events = entity('http_dates_events', {
  columns: { id: uuid().primaryKey(), at: timestamp() },
});

afterAll(() => {
  clearRegistry();
});

const stamp = action({
  input: t.object({}),
  output: t.object({ at: t.date, note: t.string }),
  policy: allow(),
  handle: () => ({ at: AT, note: AT.toISOString() }),
}).named('stampDate');

const record = action({
  input: t.object({}),
  output: events.$schema,
  policy: allow(),
  handle: () => ({ id: ID, at: AT }),
}).named('recordEvent');

const plain = action({
  input: t.object({}),
  output: t.object({ note: t.string }),
  policy: allow(),
  handle: () => ({ note: 'n' }),
}).named('plainNote');

const streamed = action({
  input: t.object({}),
  output: t.object({ at: t.date }),
  stream: t.object({ n: t.number }),
  policy: allow(),
  async *handle() {
    yield { n: 1 };
    return { at: AT };
  },
}).named('streamDate');

function fetchOf(target: AnyAction): FetchLike {
  const server = httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => userActor({ id: 'u1' }) },
  });
  return (url, init) =>
    server.fetch(
      new Request(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), origin: 'http://dev.test' },
      }),
    );
}

const post = (target: AnyAction, accept = 'application/json'): Promise<Response> =>
  fetchOf(target)(`http://dev.test${toRoute(target).path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept },
    body: '{}',
  });

describe('an action whose output holds a Date', () => {
  test('an output Date is named in x-ultimate-dates and the typed client hands back a Date', async () => {
    const response = await post(stamp);
    expect(response.headers.get(DATES_HEADER)).not.toBeNull();
    // The body is what it always was: an old client reads the ISO string it always read.
    expect(await response.json()).toEqual({ at: AT.toISOString(), note: AT.toISOString() });

    const call = stamp.client({ baseUrl: 'http://dev.test', fetch: fetchOf(stamp) });
    const out = await call({});
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at).toEqual(AT);
    expect(out.note).toBe(AT.toISOString());
  });

  test('the enveloped 200 names the instants of its data, beside x-ultimate-records', async () => {
    const response = await post(record);
    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    expect(response.headers.get(DATES_HEADER)).not.toBeNull();

    const call = record.client({ baseUrl: 'http://dev.test', fetch: fetchOf(record) });
    expect(await call({})).toEqual({ id: ID, at: AT });
  });

  test('an output with no Date sends no header', async () => {
    const response = await post(plain);
    expect(response.headers.get(DATES_HEADER)).toBeNull();
  });

  test("the streamed done frame names its output's instants on a field old clients ignore", async () => {
    const text = await (await post(streamed, 'text/event-stream')).text();
    const done = text.split('\n\n').find((block) => block.startsWith('event: done'));
    const lines = done?.split('\n') ?? [];
    const dates = lines.find((line) => line.startsWith('dates: '))?.slice(7) ?? null;
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? 'null';
    expect(dates).not.toBeNull();
    // The data line is unchanged; the paths revive it exactly as the header revives a JSON body.
    expect(JSON.parse(data)).toEqual({ at: AT.toISOString() });
    expect(reviveWireDates(JSON.parse(data) as unknown, dates)).toEqual({ at: AT });
  });

  test('a done frame with no instant carries no dates field', async () => {
    const quiet = action({
      input: t.object({}),
      output: t.object({ n: t.number }),
      stream: t.object({ n: t.number }),
      policy: allow(),
      async *handle() {
        yield { n: 1 };
        return { n: 2 };
      },
    }).named('streamQuiet');
    expect(await (await post(quiet, 'text/event-stream')).text()).toBe(
      'event: chunk\ndata: {"n":1}\n\nevent: done\ndata: {"n":2}\n\n',
    );
  });
});

// A `string | Date` column shares one pattern between text and an instant, so no path folds — as
// a chart's `[label, instant]` tuples do: 20,000 instants were a 648 KB response header, which a
// default nginx answers 502.
describe('an output whose instants cannot fold stays under the header cap', () => {
  /** `count` instants, each beside a row whose same column is text. */
  const points = (count: number) =>
    Array.from({ length: count * 2 }, (_, index) => ({
      value: index % 2 === 0 ? `label-${index}` : AT,
    }));
  const Points = t.array(t.object({ value: t.union(t.string, t.date) }));
  const Series = t.object({ points: Points });
  const logged = async (run: () => Promise<void>): Promise<readonly string[]> => {
    const lines: string[] = [];
    const release = installLogSink((line) => void lines.push(line));
    try {
      await run();
    } finally {
      release();
    }
    return lines.filter((line) => line.includes('http.wire_dates_dropped'));
  };

  test('past the cap the plain 200 carries no header, the body unchanged, one warn per action', async () => {
    const chart = action({
      input: t.object({}),
      output: Series,
      policy: allow(),
      handle: () => ({ points: points(20_000) }),
    }).named('chartSeries');
    expect(wireDatePaths({ points: points(20_000) })?.length).toBeGreaterThan(500_000);
    const lines = await logged(async () => {
      for (let call = 0; call < 2; call += 1) {
        const response = await post(chart);
        expect(response.status).toBe(200);
        expect(response.headers.get(DATES_HEADER)).toBeNull();
        const body = (await response.json()) as { points: { value: string }[] };
        expect(body.points).toHaveLength(40_000);
        expect(body.points[1]).toEqual({ value: AT.toISOString() });
      }
      // The typed client reads the ISO strings it read before the header existed.
      const call = chart.client({ baseUrl: 'http://dev.test', fetch: fetchOf(chart) });
      expect((await call({})).points[1]?.value).toBe(AT.toISOString());
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ operation: 'chartSeries', paths: 20_000 });
  });

  test('under the cap the same shape still names every instant', async () => {
    const small = action({
      input: t.object({}),
      output: Series,
      policy: allow(),
      handle: () => ({ points: points(20) }),
    }).named('chartSeriesSmall');
    const header = (await post(small)).headers.get(DATES_HEADER);
    expect(header).toBe(wireDatePaths({ points: points(20) }) ?? null);
    expect(header?.length).toBeLessThanOrEqual(WIRE_DATES_MAX_BYTES);
  });

  test('the enveloped 200 follows the same cap and keeps x-ultimate-records', async () => {
    const wide = action({
      input: t.object({}),
      output: t.object({ event: events.$schema, points: Points }),
      policy: allow(),
      handle: () => ({ event: { id: ID, at: AT }, points: points(2_000) }),
    }).named('chartWithRecord');
    const response = await post(wide);
    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    expect(response.headers.get(DATES_HEADER)).toBeNull();
  });

  test('a streamed chunk and the done frame past the cap carry no dates line, one warn', async () => {
    const live = action({
      input: t.object({}),
      output: Series,
      stream: Series,
      policy: allow(),
      async *handle() {
        yield { points: points(2_000) };
        yield { points: points(2_000) };
        yield { points: points(2) };
        return { points: points(2_000) };
      },
    }).named('chartStream');
    let text = '';
    const lines = await logged(async () => {
      text = await (await post(live, 'text/event-stream')).text();
    });
    const frames = text.split('\n\n').filter((frame) => frame !== '');
    expect(frames.map((frame) => frame.split('\n')[0])).toEqual([
      'event: chunk',
      'event: chunk',
      'event: chunk',
      'event: done',
    ]);
    expect(frames.map((frame) => frame.includes('\ndates: '))).toEqual([false, false, true, false]);
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) expect(line.length).toBeLessThan(WIRE_DATES_MAX_BYTES + 8);
      }
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ operation: 'chartStream', paths: 2_000 });
  });
});
