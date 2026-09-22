// Is the browser still answering? One cheap `evaluate('1')` raced against a short budget — the
// question the e2e preload asks before every test, because a hung browser otherwise costs every
// later suite one full CDP deadline per call (run 8) instead of one relaunch.

/** `true` when the page evaluated `1` within `ms`; a rejection or a stall is `false`, never a throw. */
export async function answersWithin(
  page: { evaluate(expression: string): Promise<unknown> },
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const answered = page.evaluate('1').then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([answered, stalled]);
  } finally {
    clearTimeout(timer);
  }
}
