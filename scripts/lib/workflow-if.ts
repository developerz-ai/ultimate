// A job's `if:` evaluated against one event, for the workflow shape tests: the subset ci.yml writes
// — `==`, `!=`, `&&`, `||`, `!`, parentheses, quoted strings, context paths and the status
// functions. A substring test passed a condition that admitted `pull_request` and still skipped
// every one (`github.ref == 'refs/heads/main' && (… || github.event_name == 'pull_request')`).

/** The context one evaluation reads; a path it does not name is `''`, as an unset output is. */
export type IfContext = Readonly<Record<string, string>>;

type Value = string | boolean;

/** Status functions as a run that has not been cancelled or failed answers them. */
const FUNCTIONS: ReadonlyMap<string, boolean> = new Map([
  ['success()', true],
  ['always()', true],
  ['cancelled()', false],
  ['failure()', false],
]);

const WORD = /\s*(\|\||&&|==|!=|!|\(|\)|'[^']*'|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*)/y;

/** The words, or undefined at the first character this subset cannot read. */
const splitWords = (source: string): readonly string[] | undefined => {
  const words: string[] = [];
  WORD.lastIndex = 0;
  while (source.slice(WORD.lastIndex).trim() !== '') {
    const match = WORD.exec(source);
    if (match?.[1] === undefined) return undefined;
    words.push(match[1]);
  }
  return words;
};

const truthy = (operand: Value): boolean =>
  typeof operand === 'boolean' ? operand : operand !== '';

/**
 * True when the job runs for `context`; undefined for an `if` outside the subset, which a caller
 * reports as unreadable rather than guessing. Every parse step answers undefined on what it cannot
 * read, and each caller passes that up.
 */
export function evaluateIf(condition: string, context: IfContext): boolean | undefined {
  const body = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  if (body.trim() === '') return true;
  const words = splitWords(body);
  if (words === undefined) return undefined;
  let at = 0;

  const value = (word: string): Value | undefined => {
    if (word.startsWith("'")) return word.slice(1, -1);
    if (word.endsWith('()')) return FUNCTIONS.get(word);
    if (word === 'true' || word === 'false') return word === 'true';
    if (['(', ')', '!', '==', '!=', '&&', '||'].includes(word)) return undefined;
    return Object.hasOwn(context, word) ? (context[word] ?? '') : '';
  };
  const primary = (): Value | undefined => {
    const word = words[at++];
    if (word === undefined) return undefined;
    if (word === '!') {
      const operand = primary();
      return operand === undefined ? undefined : !truthy(operand);
    }
    if (word !== '(') return value(word);
    const inner = or();
    return words[at++] === ')' ? inner : undefined;
  };
  const comparison = (): Value | undefined => {
    const left = primary();
    const operator = words[at];
    if (left === undefined || (operator !== '==' && operator !== '!=')) return left;
    at++;
    const right = primary();
    if (right === undefined) return undefined;
    return operator === '==' ? left === right : left !== right;
  };
  const chain = (operator: '&&' | '||', next: () => Value | undefined): Value | undefined => {
    const first = next();
    if (first === undefined) return undefined;
    let result = truthy(first);
    while (words[at] === operator) {
      at++;
      const operand = next();
      if (operand === undefined) return undefined;
      result = operator === '&&' ? result && truthy(operand) : result || truthy(operand);
    }
    return result;
  };
  const and = (): Value | undefined => chain('&&', comparison);
  const or = (): Value | undefined => chain('||', and);

  const result = or();
  return result === undefined || at !== words.length ? undefined : truthy(result);
}
