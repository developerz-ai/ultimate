/**
 * A soft visit's page read as it arrives, so it paints before its slowest hole: the shell up to the
 * server's first `STREAM_FLUSH_MARK`, then each hole's chunk as its mark lands, appended to the
 * live body with its scripts run — the reveal a full load's parser runs. No mark: read whole.
 */

import { runScripts } from './navigation-swap';
import { STREAM_FLUSH_MARK } from './stream-scripts';

/** `Node.ELEMENT_NODE`, without reading a global the router's tests do not have. */
const ELEMENT_NODE = 1;

/** What follows a streamed shell: whole chunks, until the document ends or is cancelled. */
export interface PageRest {
  /** The next run of whole chunks; `null` once the document ended (its tail is dropped). */
  next(): Promise<string | null>;
  /** Stops reading: the request is cancelled, and the server stops the holes' work. */
  cancel(): void;
}

/** The page's markup up to the shell's end, and the rest when the page streams any. */
export interface PageHead {
  readonly html: string;
  readonly rest: PageRest | null;
}

export async function readShell(body: ReadableStream<Uint8Array>): Promise<PageHead> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { html: buffer + decoder.decode(), rest: null };
    buffer += decoder.decode(value, { stream: true });
    const end = buffer.indexOf(STREAM_FLUSH_MARK);
    if (end === -1) continue;
    const html = buffer.slice(0, end);
    buffer = buffer.slice(end + STREAM_FLUSH_MARK.length);
    return { html, rest: restOf(reader, decoder, buffer) };
  }
}

function restOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  start: string,
): PageRest {
  let buffer = start;
  return {
    async next() {
      for (;;) {
        const end = buffer.lastIndexOf(STREAM_FLUSH_MARK);
        if (end !== -1) {
          const whole = buffer.slice(0, end);
          buffer = buffer.slice(end + STREAM_FLUSH_MARK.length);
          return whole;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() {
      // Settles once the request is torn down; a cancel that fails has nothing left to stop.
      reader.cancel().catch(() => undefined);
    },
  };
}

/** Everything left, for an answer shown whole (a modal): the chunks joined, the tail dropped. */
export async function drain(rest: PageRest): Promise<string> {
  let html = '';
  for (let chunk = await rest.next(); chunk !== null; chunk = await rest.next()) html += chunk;
  return html;
}

/**
 * Each chunk into the live body, in arrival order, then its scripts: the hole's `$X()` reveal and
 * whatever its `after` carries (a hole's islands). Stops at `signal` — a newer page took the body —
 * and cancels the request either way. Rejects when the stream broke under a page still on screen.
 */
export async function fillHoles(
  doc: Document,
  rest: PageRest,
  ran: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  const stop = (): void => rest.cancel();
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (let chunk = await rest.next(); chunk !== null; chunk = await rest.next()) {
      if (signal.aborted) return;
      const parsed = new DOMParser().parseFromString(`<body>${chunk}`, 'text/html');
      const nodes = [...parsed.body.childNodes].map((node) => doc.adoptNode(node));
      doc.body.append(...nodes);
      const scripts = nodes
        .filter((node): node is Element => node.nodeType === ELEMENT_NODE)
        .flatMap((el) =>
          el.tagName === 'SCRIPT' ? [el as HTMLScriptElement] : [...el.querySelectorAll('script')],
        );
      await runScripts(scripts, ran, (fresh, inert) => inert.replaceWith(fresh));
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', stop);
    rest.cancel();
  }
}
