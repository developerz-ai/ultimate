// A step's own ceiling: the race between a step body and `stepTimeout`. Split from `steps.ts` at
// the file-size ceiling — that file is the runner, and this is the one timer it arms.

/**
 * A step's own ceiling. It ABORTS before it rejects, in that order: `run()` fails the step on this
 * rejection and the job retries, so a body still holding a socket open past the deadline would be
 * racing the attempt that replaced it. Cancelling first is the only thing that can stop it.
 */
export function withStepTimeout<T>(
  work: Promise<T> | T,
  timeoutMs: number | undefined,
  deadline: AbortController,
  error: () => Error,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const failure = error();
      deadline.abort(failure);
      reject(failure);
    }, timeoutMs);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
