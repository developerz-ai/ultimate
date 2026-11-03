// A module that imports what does not resolve. It was `X_CLI_UNEXPECTED`, once per module reaching
// it, with `x doctor --json` as the fix, and doctor answered "shippable": the cycle closed on itself.
// Leaf module: `output.ts` reads it for a throw outside the scan, and the scan for one inside it.

import { stringField } from '@ultimat3/core';
import type { Finding } from './output';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';

export const IMPORT_UNRESOLVED = 'X_APP_IMPORT_UNRESOLVED';

/** npm's own shape, so `@/lib/x` (a path alias) and `node:nope` are not offered to `bun add`. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*/;

/** `@scope/pkg/sub` → `@scope/pkg`, or `undefined` for what no install can resolve. */
export const installablePackage = (specifier: string): string | undefined => {
  const name = PACKAGE_NAME.exec(specifier)?.[0];
  if (name === undefined) return undefined;
  const rest = specifier.slice(name.length);
  return rest === '' || rest.startsWith('/') ? name : undefined;
};

/**
 * Bun's `ResolveMessage`, read through `stringField`: a caught value this process did not build. The
 * `specifier` and `referrer` are the failing import's own, however many modules were importing the
 * file that holds it, which is what makes one finding per specifier true.
 */
export function unresolvedImportFinding(error: unknown, root: string): Finding | undefined {
  if (stringField(error, 'code') !== 'ERR_MODULE_NOT_FOUND') return undefined;
  const specifier = stringField(error, 'specifier');
  if (specifier === undefined) return undefined;
  const referrer = stringField(error, 'referrer');
  const at = referrer === undefined ? undefined : posixRelative(root, referrer);
  const where = at ?? 'an app module';
  const pkg = installablePackage(specifier);
  return {
    code: IMPORT_UNRESOLVED,
    cause:
      pkg === undefined
        ? `${where} imports "${specifier}", which resolves to no file`
        : `an app module imports ${pkg}, which is not installed`,
    fix:
      pkg === undefined
        ? `grep -n ${quoteArg(specifier)} ${quoteArg(where)}   # the import no file resolves: edit it`
        : `bun add ${quoteArg(pkg)}`,
    ...(at === undefined ? {} : { at }),
    meta: { specifier },
  };
}
