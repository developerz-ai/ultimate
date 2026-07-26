// Class-name combiner. Deliberately tiny: SCSS modules mean class lists are
// short, so there is no need for a `clsx`-sized dependency.

export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | Record<string, boolean | null | undefined>
  | readonly ClassValue[];

/**
 * Join truthy class values. Object keys are emitted when their value is truthy,
 * arrays are flattened, and duplicates collapse so `cx(a, a)` is stable.
 */
export function cx(...values: readonly ClassValue[]): string {
  const out: string[] = [];
  collect(values, out);
  return out.join(' ');
}

function collect(values: readonly ClassValue[], out: string[]): void {
  for (const value of values) {
    if (value === null || value === undefined || value === false || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number') {
      push(String(value), out);
    } else if (Array.isArray(value)) {
      collect(value, out);
    } else if (typeof value === 'object') {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled) push(key, out);
      }
    }
  }
}

function push(raw: string, out: string[]): void {
  for (const name of raw.split(/\s+/)) {
    if (name && !out.includes(name)) out.push(name);
  }
}
