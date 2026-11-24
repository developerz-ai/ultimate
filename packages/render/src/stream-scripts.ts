// Single responsibility: the inline script bodies out-of-order streaming emits, as constants. Its own
// module so a CSP builder can import the list without importing the stream renderer and its logger.

export const REVEAL_BODY =
  "window.$X=function(){document.querySelectorAll('template[data-x-hole]').forEach(function(t){" +
  "var s=document.getElementById(t.getAttribute('data-x-hole'));if(s){s.replaceWith(t.content);t.remove()}})}";

/** The one call every reveal makes. Constant, so a hash-based CSP can admit it. */
export const REVEAL_CALL = '$X()';

/**
 * Every inline script body a streamed document can carry — two, whatever the holes. A production
 * policy admits inline script by HASH (a `render: 'stream'` response gets no nonce), and the reveal
 * used to be one `$X("<id>")` per hole: a body per id that no policy could list, so every reveal
 * was blocked. The id now rides only in the escaped `data-x-hole` attribute, and `$X()` reveals
 * every template that has arrived.
 */
export const STREAM_REVEAL_BODIES: readonly string[] = Object.freeze([REVEAL_BODY, REVEAL_CALL]);

/**
 * Written after the shell and after each hole's chunk, in the same write: everything before it is
 * whole markup. The client router reads a soft visit as it arrives and swaps the shell at the first
 * mark, then fills each hole at the next; a full load's parser reads it as an empty comment.
 */
export const STREAM_FLUSH_MARK = '<!--x:flush-->';

/**
 * Written every `keepAliveMs` while a hole is open, always between two whole chunks: a comment the
 * parser reads as nothing, and the client router drops as it arrives (`navigation-stream.ts`).
 */
export const STREAM_KEEPALIVE_CHUNK = '<!---->';
