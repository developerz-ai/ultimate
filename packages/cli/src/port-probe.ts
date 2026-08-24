// Can this process bind that port? One implementation, because two commands ask it and they must
// not disagree: `x doctor` reports it as a finding, and `startSync` asks it after a bind failure to
// name the real cause instead of rendering a caught `Error` into a refusal.

/**
 * Binds and immediately releases. `Bun.serve({ port: 0 })` ALWAYS succeeds — the kernel picks —
 * so 0 is answered `true` without opening anything: a probe that cannot fail is worse than none,
 * and `x dev --port 0` genuinely has no port to be in use.
 */
export async function portFree(port: number): Promise<boolean> {
  if (port === 0) return true;
  try {
    const server = Bun.serve({ port, fetch: () => new Response('') });
    await server.stop(true);
    return true;
  } catch {
    // Deliberately swallowed and never rendered: the caught value is `Bun.serve`'s own
    // `Failed to start server. Is port N in use?`, and interpolating it into a `cause:` is exactly
    // what `scripts/catch-render.ts` refuses. The ANSWER is the boolean; the caller owns the words.
    return false;
  }
}
