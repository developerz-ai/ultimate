// `messagePort`: a real `MessagePort` as the engine's `PortLike` — posts pass through, the handler
// reads back as the one that was set, and clearing it detaches the port's own listener.

import { describe, expect, test } from 'bun:test';
import { messagePort, type PortMessage } from './socket-port';
import { turns, untilTurn } from './turns-fixture';

/** A `MessageChannel` hop is one task (one turn): a positive claim awaits its condition. */
const until = (check: () => boolean): Promise<void> => untilTurn(check, 'the port delivered');

describe('messagePort', () => {
  test('a message crosses with its data alone, and the handler reads back as set', async () => {
    const channel = new MessageChannel();
    const port = messagePort(channel.port1);
    const heard: unknown[] = [];
    const handler = (event: { readonly data: unknown }): void => {
      heard.push(event.data);
    };
    port.onmessage = handler;
    expect(port.onmessage).toBe(handler);
    channel.port2.postMessage({ t: 'bye' } satisfies PortMessage);
    await until(() => heard.length > 0);
    expect(heard).toEqual([{ t: 'bye' }]);

    port.onmessage = null;
    expect(port.onmessage).toBeNull();
    channel.port2.postMessage({ t: 'bye' } satisfies PortMessage);
    // Ten hops' worth of turns: a listener still attached would have heard it by now.
    await turns(10);
    expect(heard).toHaveLength(1);

    const back: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => back.push(event.data);
    port.postMessage({ t: 'close', code: 1006 });
    await until(() => back.length > 0);
    expect(back).toEqual([{ t: 'close', code: 1006 }]);
    port.close?.();
    channel.port2.close();
  });
});
