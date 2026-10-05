// Single responsibility: the stack frame of whoever called a declaration — `defineRoles()` or
// `definePermissions()` — which is the only place the declaring module's name exists by then.

export const UNKNOWN_SITE = 'unknown site';

/** `\` → `/`: Windows frames and `import.meta.dir` use `\`, and the match must hold on both. */
const toPosix = (text: string): string => text.replaceAll('\\', '/');

/**
 * This package's own source directory — `src/` in the workspace, `dist/` or `node_modules/…` once
 * installed. A frame is internal by the FILE it runs in (one of the three below), never by a name it spells: matching
 * `/definePermissions/` against the whole line skipped an app helper named
 * `definePermissionsForPosts`, and the site became whichever frame came next — a layout, or a
 * module outside the app root that the `policy` step then read as a package's declaration.
 */
const OWN_DIR = import.meta.dir;

/** The three implementation files a declaration passes through — a test beside them is a caller. */
const INTERNAL_NAMES = ['declaration-site', 'permissions', 'roles'] as const;

/**
 * The first frame of `stack` that runs outside `ownDir`'s three implementation files. Both sides
 * are compared `/`-normalised — on Windows neither the frame nor `import.meta.dir` holds a `/`,
 * so a raw `${dir}/` prefix matched nothing and every site was `callerSite` itself. The frame is
 * returned as written: its readers (`frameFile`) take a native path.
 */
export const pickCallerSite = (stack: string, ownDir: string): string => {
  const dir = toPosix(ownDir).replace(/\/$/, '');
  const prefixes = INTERNAL_NAMES.map((name) => `${dir}/${name}.`);
  const isInternal = (frame: string): boolean => {
    const posix = toPosix(frame);
    return prefixes.some((prefix) => {
      const at = posix.indexOf(prefix);
      // `permissions.test.ts` shares the prefix; only `<name>.<ext>:<line>` is the file itself.
      return at !== -1 && /^[cm]?[jt]sx?:\d/.test(posix.slice(at + prefix.length));
    });
  };
  const frames = stack.split('\n').slice(1);
  const chosen = frames.find((line) => !isInternal(line)) ?? frames[0] ?? '';
  return chosen.trim() === '' ? UNKNOWN_SITE : chosen.trim();
};

/**
 * The first frame outside this package. Not a throw: an `Error` is built only to read its stack,
 * because `X_ROLE_REDEFINED` is unactionable without both sides of a collision and the policy step
 * cannot say which module declared a permission without it.
 */
export const callerSite = (): string => {
  const stack = new Error().stack;
  return stack === undefined ? UNKNOWN_SITE : pickCallerSite(stack, OWN_DIR);
};
