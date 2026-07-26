// Flag parsing for the root scripts. Deliberately smaller than the CLI's parser: scripts take a
// handful of flags and must not grow a command tree — that is what `x` is for.

export interface ScriptArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly json: boolean;
}

export function parseScriptArgs(argv: readonly string[]): ScriptArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    index += 1;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
      continue;
    }
    flags.set(body, true);
  }
  return { positionals, flags, json: flags.get('json') === true };
}

export const flagString = (args: ScriptArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

export const flagBool = (args: ScriptArgs, name: string): boolean => args.flags.get(name) === true;

export const flagList = (args: ScriptArgs, name: string): readonly string[] =>
  (flagString(args, name) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
