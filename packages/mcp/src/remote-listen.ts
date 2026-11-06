// The long-lived `GET` stream a legacy (2025-era) streamable-HTTP server pushes its own messages on
// — `notifications/tools/list_changed` among them, for a change that happened between two calls.
// One per session, through `outbound()` like every call, detached from the request that opened it
// (`runToCompletion`) and ended by `close()`. A `405` means the server offers none: never retried.

import { isJsonObject, isUltimateError, runToCompletion, tryUseContext } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import { outbound } from '@ultimat3/core/outbound';

export interface ListenTarget {
  readonly name: string;
  readonly url: string;
  readonly dial: 'public' | 'named';
  /** The longest one stream stays open; the next call opens another. */
  readonly listenMs: number;
  /** Auth, protocol version and session id, read when the stream opens. */
  headers(): Promise<Readonly<Record<string, string>>>;
  readonly fetch?: OutboundFetch | undefined;
  /** Each notification's `method`, as it arrives. */
  heard(method: string): void;
}

/** How a stream ended: `'unsupported'` is the server saying it offers none (405), for good. */
export type ListenEnd = 'ended' | 'unsupported';

export interface Listener {
  readonly ended: Promise<ListenEnd>;
  close(): void;
}

const ONE_ATTEMPT = { attempts: 1, base: 0, max: 0, jitter: 'none' } as const;

export function openListener(target: ListenTarget): Listener {
  const controller = new AbortController();
  const ended = runToCompletion(() => listen(target, controller.signal), {
    signal: controller.signal,
  });
  return { ended, close: () => controller.abort() };
}

async function listen(target: ListenTarget, signal: AbortSignal): Promise<ListenEnd> {
  try {
    const answer = await outbound(
      {
        url: target.url,
        vendor: `mcp:${target.name}`,
        dial: target.dial,
        deadlineMs: target.listenMs,
        idleMs: target.listenMs,
        method: 'GET',
        headers: { accept: 'text/event-stream', ...(await target.headers()) },
        retry: ONE_ATTEMPT,
        read: 'stream',
        signal,
      },
      target.fetch === undefined ? {} : { fetch: target.fetch },
    );
    await readEvents(answer.stream, target.heard);
    return 'ended';
  } catch (error) {
    if (isUltimateError(error) && error.meta?.['status'] === 405) return 'unsupported';
    // The listener is a bonus over the response streams, which still carry a change: a lost one
    // is said in the log and re-opened by the next call, never thrown into a caller's answer.
    if (!signal.aborted) {
      tryUseContext()?.logger.warn('mcp.remote.listen_ended', {
        server: target.name,
        code: isUltimateError(error) ? error.code : 'unknown',
      });
    }
    return 'ended';
  }
}

/** Server-sent events, split as they arrive: each blank-line-ended event's `data:` lines. */
async function readEvents(
  stream: ReadableStream<Uint8Array>,
  heard: (method: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? '';
    for (const event of events) {
      const method = notificationOf(event);
      if (method !== undefined) heard(method);
    }
  }
}

function notificationOf(event: string): string | undefined {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (data.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // A keep-alive or a frame we cannot read: not a notification, and not ours to fail on.
    return undefined;
  }
  if (!isJsonObject(parsed) || parsed['id'] !== undefined) return undefined;
  return typeof parsed['method'] === 'string' ? parsed['method'] : undefined;
}
