// Whether a call's OWN options name a key: the key must sit directly inside an object at the
// arguments' top level. `{ env: { timeout: '5' } }` names a variable the child reads, and read as
// the call's deadline it waved an untimed child through. Shared by `spawn-timeout.ts` and
// `fetch-deadline.ts`; the shipped `raw-fetch` guard keeps its own copy, as an app file must.

/** `args` is the masked text between the call's parentheses; `key` matches the key and its `:`/`,`/`}`. */
export function hasTopLevelKey(args: string, key: RegExp): boolean {
  for (const match of args.matchAll(new RegExp(key.source, 'g'))) {
    const opened: string[] = [];
    for (const char of args.slice(0, match.index)) {
      if (char === '{' || char === '[' || char === '(') opened.push(char);
      else if (char === '}' || char === ']' || char === ')') opened.pop();
    }
    if (opened.length === 1 && opened[0] === '{') return true;
  }
  return false;
}
