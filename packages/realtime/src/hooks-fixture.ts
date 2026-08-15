// The doubles both hook suites drive: an injected socket, a closure-backed signal, and the tier-3
// client wired to both. Shared rather than copied because `hooks.test.ts` and
// `hooks-identity.test.ts` must exercise the SAME client wiring — two harnesses that drifted would
// be two clients agreeing only by construction. A `-fixture.ts` file is excluded from the tarball.

import { frozenClock } from '@ultimat3/core';
import { type ClientSocket, LiveClient, type SignalFactory } from './client';
import type { MutatorLike } from './hooks';
import type { Row } from './json';
import { type LocalTx, MemoryLocalStore } from './local-store';
import { MemoryQueueStore, OfflineQueue } from './offline-queue';
import { decode, encode, type Frame } from './sync-protocol';

export type PostRow = Row & { readonly likedByMe: boolean; readonly likeCount: number };
export type Tables = { posts: PostRow };

/** Synchronous and closure-backed: enough to prove an accessor re-reads, with no reactive runtime. */
export const signal: SignalFactory = <T>(initial: T) => {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ];
};

/** The injected socket, driven from the test: `open`/`deliver` are the server's half. */
export class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #closed: ((code: number) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.#closed?.(code);
  }

  onOpen(handler: () => void): void {
    this.#open = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }

  onClose(handler: (code: number) => void): void {
    this.#closed = handler;
  }

  open(): void {
    this.#open?.();
  }

  deliver(frame: Frame): void {
    this.#message?.(encode(frame));
  }

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

export interface Harness {
  readonly client: LiveClient<Tables>;
  readonly socket: FakeSocket;
  readonly store: MemoryLocalStore<Tables>;
  readonly queue: OfflineQueue;
}

/** Tier 3 by default — the queue and the local store are what most of these cases are about. */
export async function harness(): Promise<Harness> {
  const socket = new FakeSocket();
  const store = new MemoryLocalStore<Tables>({
    posts: [{ id: 'p1', likedByMe: false, likeCount: 2 }],
  });
  const queue = await OfflineQueue.open(new MemoryQueueStore());
  const client = new LiveClient<Tables>({
    signal,
    connect: () => socket,
    buildId: 'build-1',
    store,
    queue,
    clock: frozenClock(1_000),
    rng: () => 0,
    // Arms nothing: a closed socket here must not leave a real `setTimeout` dialling behind the
    // test that closed it. The timer itself is `client.test.ts`'s subject, not a hook suite's.
    scheduler: () => () => {},
  });
  return { client, socket, store, queue };
}

/** Every sid the client minted for a query subscription, in order — a test never picks one. */
export function querySids(socket: FakeSocket, op: 'add' | 'drop'): readonly string[] {
  const sids: string[] = [];
  for (const frame of socket.frames()) {
    if (frame.type === 'subscribe' && frame.op === op && frame.target.kind === 'query') {
      sids.push(frame.sid);
    }
  }
  return sids;
}

export function querySid(socket: FakeSocket, op: 'add' | 'drop'): string {
  return querySids(socket, op)[0] ?? '';
}

/** The idempotency key of the mutation the client sent — so a test can ack/fail it by ref. */
export function sentMutateKey(socket: FakeSocket): string {
  for (const frame of socket.frames()) {
    if (frame.type === 'mutate') return frame.key;
  }
  return '';
}

/**
 * Lets a fire-and-forget chain inside `client.ts` (a reconnect drain, an async ack) settle before
 * the test reads the state it produced.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export const liveFeed = { name: 'liveFeed' };

/**
 * Narrower than `MutatorLike` on both parameters, which is the point: this is the shape
 * `@ultimat3/action`'s `mutator()` produces, and it has to assign with no cast at the call site.
 */
export const likePost = {
  name: 'likePost',
  local(tx: LocalTx<Tables>, input: { readonly postId: string }): void {
    tx.posts.update(input.postId, (post) =>
      post.likedByMe ? {} : { likedByMe: true, likeCount: post.likeCount + 1 },
    );
  },
} satisfies MutatorLike;
