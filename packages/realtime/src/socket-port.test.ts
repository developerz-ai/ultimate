// `messagePort`: a real `MessagePort` as the engine's `PortLike` — posts pass through, the handler
// reads back as the one that was set, and clearing it detaches the port's own listener.

import { describe, expect, test } from 'bun:test';
import { messagePort, type PortMessage } from './socket-port';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

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
    await settle();
    expect(heard).toEqual([{ t: 'bye' }]);

    port.onmessage = null;
    expect(port.onmessage).toBeNull();
    channel.port2.postMessage({ t: 'bye' } satisfies PortMessage);
    await settle();
    expect(heard).toHaveLength(1);

    const back: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => back.push(event.data);
    port.postMessage({ t: 'close', code: 1006 });
    await settle();
    expect(back).toEqual([{ t: 'close', code: 1006 }]);
    port.close?.();
    channel.port2.close();
  });
});
