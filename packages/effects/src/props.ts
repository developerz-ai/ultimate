// The prop screens every entry runs before it draws: a number inside the range the effect can
// render, a role the palette has. A JavaScript caller (or a `defineTheme`-less island) gets
// `X_EFFECTS_INVALID_VALUE` naming the entry, the prop and the range, never a NaN in a shader.

import { COLOR_ROLES, type ColorRole } from '@ultimat3/ui';
import { EffectsInvalidValueError } from './errors';

/** `value`, or `fallback` when unset; anything outside `[min, max]` or not finite is refused. */
export function rangeProp(
  entry: string,
  prop: string,
  value: number | undefined,
  range: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  if (value === undefined) return range.fallback;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max
  )
    return value;
  // The call to paste, built first: its tag is the entry's name, so the line opens with it.
  const call = `<${entry} ${prop}={${range.fallback}} />`;
  throw new EffectsInvalidValueError({
    cause: `<${entry} ${prop}> is ${String(value)}, outside ${range.min}..${range.max}`,
    fix: `${call}   // any finite number from ${range.min} to ${range.max}`,
  });
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(COLOR_ROLES);

/** A palette of roles, `fallback` when unset; an unknown role or a size outside `count` is refused. */
export function rolesProp(
  entry: string,
  value: readonly ColorRole[] | undefined,
  fallback: readonly ColorRole[],
  count: { readonly min: number; readonly max: number },
): readonly ColorRole[] {
  if (value === undefined) return fallback;
  const unknown = value.find((role) => !KNOWN_ROLES.has(role));
  const sized = value.length >= count.min && value.length <= count.max;
  if (unknown === undefined && sized) return value;
  const call = `<${entry} roles={${JSON.stringify(fallback)}} />`;
  throw new EffectsInvalidValueError({
    cause:
      unknown === undefined
        ? `<${entry} roles> names ${value.length} roles, outside ${count.min}..${count.max}`
        : `<${entry} roles> names '${String(unknown)}', which is not a colour role`,
    fix: `${call}   // ${count.min} to ${count.max} names from COLOR_ROLES in @ultimat3/ui`,
  });
}

/** The inline custom properties carrying a palette: `--fx-c0: var(--color-accent)` and so on. */
export function roleVars(roles: readonly ColorRole[]): Record<string, string> {
  const vars: Record<string, string> = {};
  roles.forEach((role, index) => {
    vars[`--fx-c${index}`] = `var(--color-${role})`;
  });
  return vars;
}
