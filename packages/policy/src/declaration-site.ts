// Single responsibility: the stack frame of whoever called a declaration — `defineRoles()` or
// `definePermissions()` — which is the only place the declaring module's name exists by then.

export const UNKNOWN_SITE = 'unknown site';

/**
 * The first frame that is not one of `internal`. Not a throw: an `Error` is built only to read its
 * stack, because `X_ROLE_REDEFINED` is unactionable without both sides of a collision and the
 * policy step cannot say which module declared a permission without it.
 */
export const callerSite = (internal: RegExp): string => {
  const stack = new Error().stack;
  if (stack === undefined) return UNKNOWN_SITE;
  const frames = stack.split('\n').slice(1);
  const frame = frames.find((line) => !internal.test(line) && !/callerSite/.test(line));
  const chosen = frame ?? frames[0] ?? '';
  return chosen.trim() === '' ? UNKNOWN_SITE : chosen.trim();
};
