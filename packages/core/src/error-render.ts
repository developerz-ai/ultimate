// Single responsibility: turn a value the framework does not control into text for an error's
// `cause` or `fix`, without ever throwing while doing it. An error factory that dies formatting
// its own message replaces the refusal with a `TypeError`, and `error.code === 'X_…'` then
// matches nothing — the last message that may be lost to its own rendering.

/**
 * A value from an app, rendered for a `cause`. `JSON.stringify` raises a `TypeError` on a bigint
 * and on a cyclic structure, RUNS any `toJSON` the value carries and reads every enumerable
 * getter — so building the message can raise INSTEAD of the refusal. The caller then catches a
 * `TypeError` where a validation denial belongs, catching by code finds nothing, and an HTTP
 * surface answers 500 rather than the mapped status.
 *
 * A cause DESCRIBES, so degrading to a type name costs a reader nothing they needed. Template
 * interpolation is avoided for the same reason: `` `${symbol}` `` throws where `String(symbol)`
 * does not. Lifted from `@ultimat3/entity`'s `renderValue` — the spelling two independent fixes
 * converged on — including its `a ${typeof value}` fallback for the values `JSON.stringify`
 * answers `undefined` for: a function's source is neither bounded nor a thing a reader wants.
 *
 * Text for a `fix:` goes through `renderFixLiteral` instead, because a fix has to parse.
 */
export function renderCauseValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  try {
    return JSON.stringify(value) ?? `a ${typeof value}`;
  } catch {
    return `a ${typeof value} that cannot be rendered`;
  }
}

/**
 * The same value where the text has to PARSE — a `fix:` is pasted and run, so a degraded type
 * name in it produces a command that does not work. A string becomes its quoted literal; anything
 * else becomes the placeholder, which is a parameter because what is missing differs by call
 * site: an org id in one fix line, a flag key in the next, and a fix that names the wrong thing
 * is not a fix. `JSON.stringify` cannot throw on a string primitive.
 *
 * Lifted from `@ultimat3/entity`'s `asLiteral`.
 */
export function renderFixLiteral(value: unknown, placeholder: string): string {
  return typeof value === 'string' ? JSON.stringify(value) : placeholder;
}

/** `JSON.stringify` with its throw removed: did the value survive being serialised at all? */
const canRender = (value: unknown): boolean => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};

/** A record's own keys, or none — a `Proxy` may refuse to be enumerated, and `ownKeys` throws. */
const metaKeys = (meta: Readonly<Record<string, unknown>>): readonly string[] => {
  try {
    return Object.keys(meta);
  } catch {
    return [];
  }
};

/** One entry, kept as it is when it renders — reading it is its own throw, past a getter. */
const metaEntry = (meta: Readonly<Record<string, unknown>>, key: string): unknown => {
  try {
    const value = meta[key];
    return canRender(value) ? value : renderCauseValue(value);
  } catch {
    return 'a value that cannot be read';
  }
};

/**
 * The third surface, one layer past the two above: `UltimateError.toJSON()` hands `meta` straight
 * to `JSON.stringify`, so a bigint, a cycle or a hostile `toJSON` in it throws at `--json` RENDER
 * time — after a constructor the renderers already made safe. `parseId` puts the rejected value in
 * `meta` itself, so core feeds it uncontrolled values on its own.
 *
 * `meta` is MACHINE-READ, which decides the shape: a record that serialises is returned unchanged,
 * value identity included, because describing a value a caller parses today would be a worse bug
 * than the throw. Only what cannot be rendered degrades, and it degrades one key at a time — a
 * single broken value must not cost the reader the keys beside it. The cost of that pass-through
 * is one extra `JSON.stringify` of a small record on an error path, and any `toJSON` in it running
 * twice; a `toJSON` with side effects is already outside what an error's `meta` may carry.
 */
export function renderMetaRecord(
  meta: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (meta === undefined || canRender(meta)) return meta;
  const out: Record<string, unknown> = {};
  for (const key of metaKeys(meta)) out[key] = metaEntry(meta, key);
  return out;
}
