// Single responsibility: the opt-in that makes a `db.statement` event carry the stack it was SENT
// from. Off by default and never turned on by production — a stack per statement is real cost —
// so only a holder that needs to name a loop's line (`@ultimat3/testing`'s `statements` fixture)
// pays for it, and only for as long as it holds it. Ref-counted: nested holders compose.

let holders = 0;

/** Turn stack capture on until the returned release is called. Releasing twice is a no-op. */
export function captureStatementStacks(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
  };
}

/** Whether any holder has stack capture on. One integer read: the emitter's whole cost when off. */
export function statementStacksCaptured(): boolean {
  return holders > 0;
}

/**
 * The caller's stack NOW — read by an emitter BEFORE its first `await`, because an awaited
 * continuation keeps no caller frames. `undefined` while capture is off: nothing is built.
 */
export function callerStack(): string | undefined {
  if (holders === 0) return undefined;
  const site: { stack?: string } = {};
  Error.captureStackTrace(site, callerStack);
  return site.stack;
}

/** TEST SEAM: every holder dropped. */
export function resetStatementStacks(): void {
  holders = 0;
}
