// An action's `Date` output over the real pipeline: the plain 200, the enveloped 200 and the
// streamed `done` frame each name their instants (`x-ultimate-dates`, the read projection's rule),
// so the typed client hands back the `Date` the output type promises. The body stays the ISO text.

import { afterAll, describe, expect, test } from 'bun:test';
import { DATES_HEADER, RECORDS_HEADER, reviveWireDates, userActor } from '@ultimat3/core';
import { clearRegistry, entity, timestamp, uuid } from '@ultimat3/entity';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
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
