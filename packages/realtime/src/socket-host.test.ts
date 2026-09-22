// Host selection: a SharedWorker when there is one, the in-page engine when there is not — absent,
// or refused by the browser — and one worker per principal, never a socket shared across two.

import { describe, expect, test } from 'bun:test';
import { openHost, type SharedWorkerLike, workerName } from './socket-host';

/** A SharedWorker double: records the name it was constructed with, hands back a real port. */
function recordingWorker(names: string[]): SharedWorkerLike {
  return class {
    readonly port: MessagePort;
    constructor(_url: string, options: { name: string }) {
      names.push(options.name);
      this.port = new MessageChannel().port1;
    }
  };
}

const refusingWorker: SharedWorkerLike = class {
  readonly port: MessagePort = new MessageChannel().port1;
  constructor() {
    throw new TypeError('SharedWorker is disabled in this context');
  }
};

describe('openHost', () => {
  test('a built worker and a SharedWorker: the worker hosts the socket, named by principal', () => {
    const names: string[] = [];
    const host = openHost({
      workerUrl: '/_x/sync-worker/abc.js',
      scope: 'alice',
      sharedWorker: recordingWorker(names),
    });
    expect(host.kind).toBe('worker');
    expect(names).toEqual([workerName('alice')]);
    host.bye();
  });

  test('no SharedWorker in this browser is the in-page host', () => {
    const host = openHost({ workerUrl: '/_x/sync-worker/abc.js', scope: 'alice' });
    // Bun has no SharedWorker, which is exactly the case.
    expect(typeof SharedWorker).toBe('undefined');
    expect(host.kind).toBe('in-page');
    host.bye();
  });

  test('a constructor that throws (sandboxed iframe) is the in-page host, never an error', () => {
    const host = openHost({ workerUrl: '/w.js', scope: 'alice', sharedWorker: refusingWorker });
    expect(host.kind).toBe('in-page');
    host.bye();
  });

  test('no worker built is the in-page host', () => {
    const names: string[] = [];
    const host = openHost({ scope: 'alice', sharedWorker: recordingWorker(names) });
    expect(host.kind).toBe('in-page');
    expect(names).toEqual([]);
    host.bye();
  });

  test('a principal change is a different worker name — two principals never share a socket', () => {
    expect(workerName('alice')).not.toBe(workerName('bob'));
    expect(workerName(null)).not.toBe(workerName('alice'));
  });
});
