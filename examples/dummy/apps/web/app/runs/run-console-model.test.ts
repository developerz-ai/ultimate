// The console's model against a client that answers what it is told: which write each control
// makes, with which input, and what the console says when one does not happen.
import { UltimateError } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import type { ConsoleClient } from './run-console-model';
import { createConsole } from './run-console-model';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const LEDGER = { id: '00000000-0000-4000-8000-0000000000d1', label: 'Ledger' };
const BANK = { id: '00000000-0000-4000-8000-0000000000d2', label: 'Bank' };
const RUN = { runId: '00000000-0000-4000-8000-0000000000b1', jobId: 'job-1' };

/** Every call the model made, and a switch that makes the next one fail. */
const fakeClient = (failure?: unknown) => {
  const calls: { readonly name: string; readonly input: unknown }[] = [];
  const answer = <T>(name: string, input: unknown, value: T): Promise<T> => {
    calls.push({ name, input });
    return failure === undefined ? Promise.resolve(value) : Promise.reject(failure);
  };
  const client: ConsoleClient = {
    connectSite: (input) =>
      answer('connectSite', input, { ...BANK, createdAt: new Date('2026-10-01T09:00:00.000Z') }),
    startRun: (input) => answer('startRun', input, RUN),
    answerPrompt: (input) => answer('answerPrompt', input, { runId: RUN.runId, prompt: 1 }),
    cancelRun: (input) => answer('cancelRun', input, { runId: RUN.runId }),
  };
  return { client, calls };
};

const refused = new UltimateError({
  code: 'X_FORBIDDEN',
  cause: 'denied',
  fix: 'x policy explain',
});

unitTest('the first connection is picked, and no run is followed', () => {
  const model = createConsole({ orgId: ORG, connections: [LEDGER, BANK] }, fakeClient().client);
  expect(model.selected()).toBe(LEDGER.id);
  expect(model.run()).toBeNull();
  expect(model.fault()).toBeNull();
  expect(model.busy()).toBe(false);
});

unitTest('with no connection nothing is picked, and a seeded run is followed', () => {
  const model = createConsole({ orgId: ORG, connections: [], run: RUN }, fakeClient().client);
  expect(model.selected()).toBe('');
  expect(model.run()).toEqual(RUN);
});

unitTest('start runs the picked connection and follows the handle it is answered', async () => {
  const { client, calls } = fakeClient();
  const model = createConsole({ orgId: ORG, connections: [LEDGER, BANK] }, client);
  model.select(BANK.id);
  await model.start();
  expect(calls).toEqual([{ name: 'startRun', input: { orgId: ORG, connectionId: BANK.id } }]);
  expect(model.run()).toEqual(RUN);
  expect(model.busy()).toBe(false);
});

unitTest('a start the server refused follows nothing and says so', async () => {
  const model = createConsole({ orgId: ORG, connections: [LEDGER] }, fakeClient(refused).client);
  await model.start();
  expect(model.run()).toBeNull();
  expect(model.fault()).toBe('start');
  expect(model.busy()).toBe(false);
});

unitTest('connect adds the site first and picks it', async () => {
  const { client, calls } = fakeClient();
  const model = createConsole({ orgId: ORG, connections: [LEDGER] }, client);
  await model.connect('Bank', 'hunter2-hunter2');
  expect(calls[0]?.input).toEqual({ orgId: ORG, label: 'Bank', credential: 'hunter2-hunter2' });
  expect(model.connections()).toEqual([BANK, LEDGER]);
  expect(model.selected()).toBe(BANK.id);
});

unitTest('answer and cancel name the run being followed', async () => {
  const { client, calls } = fakeClient();
  const model = createConsole({ orgId: ORG, connections: [LEDGER], run: RUN }, client);
  await model.answer(1, '482913');
  await model.cancel();
  expect(calls).toEqual([
    {
      name: 'answerPrompt',
      input: { orgId: ORG, runId: RUN.runId, prompt: 1, answer: '482913' },
    },
    { name: 'cancelRun', input: { orgId: ORG, runId: RUN.runId } },
  ]);
});

unitTest('with no run followed, answer and cancel send nothing', async () => {
  const { client, calls } = fakeClient();
  const model = createConsole({ orgId: ORG, connections: [LEDGER] }, client);
  await model.answer(1, '482913');
  await model.cancel();
  expect(calls).toEqual([]);
  expect(model.fault()).toBeNull();
});

unitTest('each refused write is named, and the next attempt clears it', async () => {
  const failing = createConsole(
    { orgId: ORG, connections: [LEDGER], run: RUN },
    fakeClient(refused).client,
  );
  await failing.answer(1, '1');
  expect(failing.fault()).toBe('answer');
  await failing.cancel();
  expect(failing.fault()).toBe('cancel');
  await failing.connect('Bank', 'x');
  expect(failing.fault()).toBe('connect');

  const { client } = fakeClient();
  const working = createConsole({ orgId: ORG, connections: [LEDGER], run: RUN }, client);
  await working.cancel();
  expect(working.fault()).toBeNull();
});

unitTest('an answer for a principal that signed out is dropped, not reported', async () => {
  const superseded = new UltimateError({
    code: 'X_CLIENT_SCOPE_CHANGED',
    cause: 'the page changed principal',
    fix: 'x doctor --json',
  });
  const model = createConsole({ orgId: ORG, connections: [LEDGER] }, fakeClient(superseded).client);
  await model.start();
  expect(model.fault()).toBeNull();
});
