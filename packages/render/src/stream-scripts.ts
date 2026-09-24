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
