// `PgConnection.watchIdle`: a session doing nothing has no reader, so a server that ended it was
// only noticed by the next statement — which, for a session held for its advisory lock, is never.

import { describe, expect, test } from 'bun:test';
import {
  commandComplete,
  dataRow,
  errorResponse,
  FakeStream,
  openTrusted,
  readyForQuery,
} from './pg-connection-fixture';

const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
};

describe('watchIdle', () => {
  test('a closed socket is reported once, with why', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    const ends: string[] = [];
    connection.watchIdle((reason) => ends.push(reason));
    await turns();
    expect(ends).toEqual([]);

    stream.end();
    await turns();
    expect(ends).toEqual(['the server closed the connection']);
  });

  test('a FATAL from the server is reported with what the server said', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    const ends: string[] = [];
    connection.watchIdle((reason) => ends.push(reason));
    stream.push(errorResponse({ S: 'FATAL', C: '57P01', M: 'terminating connection' }));
    stream.end();
    await turns();

    expect(ends).toHaveLength(1);
    expect(ends[0]).toContain('terminating connection');
  });

  test('a query takes the parked read over, gets its own answer, and the watch resumes', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    const ends: string[] = [];
    connection.watchIdle((reason) => ends.push(reason));
    await turns();

    const asked = connection.query('SELECT 1');
    await turns();
    stream.push(dataRow('1'), commandComplete('SELECT 1'), readyForQuery());
    expect(await asked).toEqual([['1']]);
    expect(ends).toEqual([]);

    // Still watching after the statement: the session dying now is seen now.
    stream.end();
    await turns();
    expect(ends).toEqual(['the server closed the connection']);
  });

  test('close() is not an end: the owner hanging up is told nothing', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    const ends: string[] = [];
    connection.watchIdle((reason) => ends.push(reason));
    await connection.close();
    await turns();
    expect(ends).toEqual([]);
  });
});
