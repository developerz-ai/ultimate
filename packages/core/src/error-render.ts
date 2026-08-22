// Single responsibility: turn a value the framework does not control into text for an error's
// `cause` or `fix`, without ever throwing while doing it. An error factory that dies formatting
// its own message replaces the refusal with a `TypeError`, and `error.code === 'X_…'` then
// matches nothing — the last message that may be lost to its own rendering.

/**
 * The cap on a rendered cause, in characters. A cause is READ — one log line, one `--json` field,
 * one terminal paragraph — and the value it describes is the app's, so it can be a megabyte of
 * request body. `JSON.stringify` has neither an output limit nor a streaming mode, so without a
 * bound the whole of that value became the error's `message`, its log line and its `--json` field,
 * and stayed there for the life of the error. Past every real cause in this repo, short of
 * anything that costs.
 */
export const MAX_RENDERED_LENGTH = 512;

/** The last guard: whatever survived the bounded walk still ends at the cap, ellipsis included. */
const truncate = (text: string): string =>
  text.length <= MAX_RENDERED_LENGTH ? text : `${text.slice(0, MAX_RENDERED_LENGTH - 1)}…`;

/**
 * `JSON.stringify` with a budget. The replacer runs before each value is serialised, so a long
 * string is cut and the entries past the budget are dropped BEFORE they are written — the point
 * being that the bound is on what gets allocated, not on a full serialisation trimmed afterwards.
 * Dropping degrades exactly as the language already does: an object key disappears, an array slot
 * becomes `null`.
 */
const boundedJson = (value: unknown): string | undefined => {
  let spent = 0;
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (spent > MAX_RENDERED_LENGTH) return undefined;
    if (typeof entry !== 'string') {
      spent += 1;
      return entry;
    }
    spent += entry.length;
    return entry.length > MAX_RENDERED_LENGTH ? `${entry.slice(0, MAX_RENDERED_LENGTH)}…` : entry;
  });
};

/**
 * A value from an app, rendered for a `cause`. `JSON.stringify` raises a `TypeError` on a bigint
 * and on a cyclic structure, RUNS any `toJSON` the value carries and reads every enumerable
 * getter — so building the message can raise INSTEAD of the refusal. The caller then catches a
 * `TypeError` where a validation denial belongs, catching by code finds nothing, and an HTTP
 * surface answers 500 rather than the mapped status.
 *
 * A cause DESCRIBES, so degrading to a type name — or to a bounded prefix — costs a reader nothing
 * they needed. Template interpolation is avoided for the same reason: `` `${symbol}` `` throws
 * where `String(symbol)` does not. Lifted from `@ultimat3/entity`'s `renderValue` — the spelling
 * two independent fixes converged on — including its `a ${typeof value}` fallback for the values
 * `JSON.stringify` answers `undefined` for: a function's source is neither bounded nor a thing a
 * reader wants.
 *
 * Text for a `fix:` goes through `renderFixLiteral` instead, because a fix has to parse.
 */
export function renderCauseValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  try {
    return truncate(boundedJson(value) ?? `a ${typeof value}`);
  } catch {
    return `a ${typeof value} that cannot be rendered`;
  }
}

/**
 * One line, always. Escapes every character that a line-oriented reader would treat as a line
 * break, leaving everything else byte-identical.
 *
 * WHY this exists at all: `renderCauseValue` above is safe against a value that THROWS while
 * rendering, and safe against a value that LEAKS. It is not safe against a value that is already
 * a `string` — a `string` renders fine, so nothing objected to it — and a caller-controlled
 * string can carry a newline. The 3-line contract format (`<code>` / `  cause: …` / `  fix:   …`)
 * is line-oriented in the terminal, in CI logs and inside the dev overlay's `<pre>`, so one
 * newline in a `cause` writes a second line an operator reads as a genuine framework message.
 * Reproduced with a forged OIDC `iss` claim: an unauthenticated stranger with one crafted token.
 *
 * At the RENDERER, not at the call site, deliberately. `bun run error-render` cannot see this
 * class — its rule is about `unknown` reaching a `cause:` — and three holes shipped in
 * `@ultimat3/auth` alone under a green check. A rule every call site must remember is a rule the
 * 296th call site forgets; there are six renderers of this format and no more, so escaping there
 * is one place instead of every place (issue #97, option 3).
 *
 * `\u2028` and `\u2029` are included because they terminate a line for a JavaScript parser and
 * for several log viewers, while `String.prototype.split('\n')` never sees them.
 *
 * The set is every C0 control, DEL, and `\u2028`/`\u2029`. Line breaks are the structural half —
 * they add a line to a line-oriented format — and the rest ride along because a terminal reads them
 * as commands of its own: a raw `\u001b` in a cause is an ANSI escape, so a value could repaint the
 * screen, hide the line above it or move the cursor over what a reader had already been shown.
 *
 * NOT a general sanitiser. A `cause` is prose and keeps its quotes, its backslashes, its percent
 * signs and every printable character it arrived with; only the control range is touched.
 */
export function singleLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point.
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (char) => {
    const known = CONTROL_ESCAPES[char];
    if (known !== undefined) return known;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** The spellings a reader already knows from a JSON string, so the escape reads as an escape. */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  '\n': String.raw`\n`,
  '\r': String.raw`\r`,
  '\t': String.raw`\t`,
  '\b': String.raw`\b`,
  '\f': String.raw`\f`,
};

/**
 * `value instanceof Error`, made total. The test itself can throw: a `Proxy`'s `getPrototypeOf`
 * trap runs during `instanceof`, and the one place this question is asked is a `catch` block that
 * has nothing left to answer with if it does.
 */
export function isThrownError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * A caught value as text: an `Error`'s own words where it has them, `renderCauseValue` everywhere
 * else. `.name` and `.message` are ordinary property reads, so a subclass with a getter — or a
 * `Proxy` — makes the read throw exactly where the catch block cannot afford it.
 *
 * One helper because the framework spelled `error instanceof Error ? error.message : …` in seven
 * places, each carrying the same hole: `toUltimateError`, `@ultimat3/http`'s `finalizeFailed`,
 * `@ultimat3/auth`'s OAuth callback, three CLI reporters and `@ultimat3/realtime`'s wire error.
 */
export function renderThrowable(value: unknown): string {
  try {
    if (value instanceof Error) {
      const name = typeof value.name === 'string' ? value.name : 'Error';
      const message = value.message;
      return truncate(
        `${name}: ${typeof message === 'string' ? message : renderCauseValue(message)}`,
      );
    }
  } catch {
    // The value fought being read, which is the case this function exists for: render it whole.
  }
  return renderCauseValue(value);
}

/**
 * One string field off a value that may fight being read. An `UltimateError` crossing a worker,
 * a subprocess or a WebSocket arrives as a plain object, so every surface that re-renders one asks
 * structurally — `typeof value.code === 'string'` — and that read is a getter call, or a `Proxy`'s
 * `get` trap, on a value the framework did not build. It throws in the one place with nothing left
 * to answer with: the catch block deciding what the caller sees. The renderers above are total and
 * were still reached past three of these reads.
 *
 * `undefined` covers absent, wrong type and threw, because each one means the same thing to every
 * caller: this value did not supply the field, so use the default.
 */
export function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const held = (value as Record<string, unknown>)[key];
    return typeof held === 'string' ? held : undefined;
  } catch {
    return undefined;
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
    // A function passes `canRender` — `JSON.stringify(fn)` answers `undefined` rather than
    // throwing — but copying one into the record moves the throw one layer out instead of removing
    // it: a `meta` carrying an enumerable `toJSON` is INVOKED when `--json` serialises the error
    // around it, which is the render this whole file exists to keep alive. Rendered, never copied.
    return canRender(value) && typeof value !== 'function' ? value : renderCauseValue(value);
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

/**
 * The shape of a rejected value — **never its content**.
 *
 * WHY: `renderCauseValue` above is safe against THROWING, not against LEAKING. It is the right
 * renderer for a value the framework itself built; it is the wrong one for a value a caller
 * supplied, because a `cause` is not a private diagnostic — it is folded into an HTTP problem
 * document AND written into the log line, and the logger redacts `fields` by key, so a value
 * baked into a message string has no key left to redact. That is not hypothetical: it was
 * reproduced this cycle that a validator echoing a rejected value wrote mistyped passwords to
 * both the log index and the user's own network tab.
 *
 * So: type and length, which is what a format or type violation actually needs, and nothing else.
 * There is no dev-only escape hatch on purpose — a flag is one misconfigured environment away
 * from being the same breach.
 *
 * A deliberate duplicate of `describeValue` in `packages/schema/src/describe-value.ts`, for the
 * reason `SCHEMA_ERROR_CODE_TITLES` is one: `@ultimat3/schema` is tier 0 alongside this package,
 * so neither may import the other. Keep the two answering IDENTICALLY — that is what
 * `packages/cli/src/describe-value-pin.test.ts` holds — and changing one alone is the bug.
 */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return countOf(charCount(value), 'string', 'character');
    case 'number':
      return describeNumber(value);
    case 'boolean':
      return 'a boolean';
    case 'bigint':
      return 'a bigint';
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
    default:
      break;
  }
  if (Array.isArray(value)) return countOf(value.length, 'array', 'item');
  // `getTime()` rather than a value: an invalid Date is the one Date fact a caller can act on.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'an invalid Date' : 'a Date';
  return 'an object';
}

function describeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return 'a number';
}

function countOf(size: number, noun: string, unit: string): string {
  if (size === 0) return `an empty ${noun}`;
  const article = noun === 'array' ? 'an' : 'a';
  return `${article} ${noun} of ${size} ${unit}${size === 1 ? '' : 's'}`;
}

/**
 * The twin of `@ultimat3/schema`'s `char-count.ts`, duplicated for the same reason `describeValue`
 * is: both packages are tier 0 and neither may import the other. Code points, because the rules
 * that reject a string count in them and the message must quote the same unit — `'👍'.length` is 2.
 * Only a surrogate makes the two counts differ, so every ASCII value keeps the O(1) read.
 */
const HAS_SURROGATE = /[\uD800-\uDBFF]/;

function charCount(value: string): number {
  return HAS_SURROGATE.test(value) ? [...value].length : value.length;
}
