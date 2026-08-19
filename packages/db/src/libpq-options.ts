// Single responsibility: merging the framework's own libpq `options` into whatever the operator
// already put in `DATABASE_URL`. A connection string is the operator's file, not the framework's,
// and `searchParams.set` on a key they may have written is a silent overwrite of their setting.

/**
 * libpq hands `options` to the backend as command-line arguments, split on whitespace with a
 * backslash escaping the next character. Escapes are kept intact, so re-joining the tokens
 * reproduces the operator's string byte for byte.
 */
export function splitLibpqOptions(options: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let open = false;
  for (let index = 0; index < options.length; index += 1) {
    const char = options[index] ?? '';
    const escaped = options[index + 1];
    if (char === '\\' && escaped !== undefined) {
      current += `\\${escaped}`;
      open = true;
      index += 1;
      continue;
    }
    if (char.trim() === '') {
      if (open) tokens.push(current);
      current = '';
      open = false;
      continue;
    }
    current += char;
    open = true;
  }
  if (open) tokens.push(current);
  return tokens;
}

/**
 * The three spellings a backend accepts for one GUC on the command line: `-c name=value` as two
 * arguments, `-cname=value` as one, and `--name=value` (where a hyphen in the name reads as an
 * underscore). A bare `name=value` token is the second half of the first spelling.
 */
const ASSIGNS = (name: string): RegExp => new RegExp(`^(?:-c|--)?${name.replaceAll('_', '[_-]')}=`);

/** Drops every assignment of `name`, and the `-c` that introduced it. */
function without(tokens: readonly string[], name: string): readonly string[] {
  const assigns = ASSIGNS(name);
  const kept: string[] = [];
  for (const token of tokens) {
    if (!assigns.test(token)) {
      kept.push(token);
      continue;
    }
    if (kept.at(-1) === '-c') kept.pop();
  }
  return kept;
}

/**
 * Whether the operator already set `name` in their own `options` — the second spelling of a
 * setting that also has a URL parameter. A framework DEFAULT may not overwrite either one, and
 * a default that checks only the parameter leaves the two spellings free to disagree.
 */
export function declaresLibpqOption(existing: string | null, name: string): boolean {
  const assigns = ASSIGNS(name);
  return splitLibpqOptions(existing ?? '').some((token) => assigns.test(token));
}

/**
 * The operator's `options` with the framework's settings merged in.
 *
 * **Precedence: the framework wins on the settings it names, the operator keeps everything else.**
 * A role's `statement_timeout` is a safety bound the role is sized around — `web`'s 10s is what
 * stops a slow endpoint holding all 20 pool slots — so a value in the URL may not raise it; but a
 * `search_path`, an `application_name` or a `-c` an operator added is theirs and must survive.
 * Enforced by removing the framework's own names before appending, never by position: relying on
 * "the last `-c` wins" would make the bound depend on backend argument order nobody here measured.
 */
export function mergeLibpqOptions(
  existing: string | null,
  settings: Readonly<Record<string, string>>,
): string {
  let tokens = splitLibpqOptions(existing ?? '');
  for (const [name, value] of Object.entries(settings)) {
    tokens = [...without(tokens, name), '-c', `${name}=${value}`];
  }
  return tokens.join(' ');
}
