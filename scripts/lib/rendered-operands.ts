// What one template substitution renders, as bare expressions — `error-render`'s question "is this
// `${…}` the unknown value itself?", answered past what is erased at runtime (`as T`, `!`, a
// group) and through a `??` / `||` fallback, either operand of which is rendered on some input.

/** The bracket pairs a depth count over masked code tracks. */
export const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{']);
export const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);

/** `(x)` wraps its whole text in one group — `(a) + (b)` does not. */
function wrapped(expr: string): boolean {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < expr.length - 1; i += 1) {
    if (OPENERS.has(expr[i] as string)) depth += 1;
    else if (CLOSERS.has(expr[i] as string)) depth -= 1;
    if (depth === 0) return false;
  }
  return true;
}

/** The text with what is erased at runtime peeled off: `as T`, `satisfies T`, `!`, a group. */
function peeled(expr: string): string {
  let text = expr.trim();
  for (let before = ''; before !== text; ) {
    before = text;
    if (wrapped(text)) text = text.slice(1, -1).trim();
    text = text
      .replace(/!+$/, '')
      .replace(/\s+(?:as|satisfies)\s+[\w$.<>[\],\s|&]+$/, '')
      .trim();
  }
  return text;
}

/** Top-level `??` / `||` operands — each one is what the substitution renders on some input. */
function fallbackOperands(expr: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i] as string;
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) depth -= 1;
    const pair = expr.slice(i, i + 2);
    if (depth === 0 && (pair === '??' || pair === '||') && expr[i + 2] !== '=') {
      parts.push(expr.slice(from, i));
      from = i + 2;
      i += 1;
    }
  }
  return [...parts, expr.slice(from)];
}

/**
 * What a `${…}` substitution renders, as bare expressions: `${value as string}`, `${value!}`,
 * `${(value)}` and `${label ?? value}` all render `value` itself, so each compares to the binding
 * like `${value}` does. A read OF it (`${(value as Error).message}`) stays a different text.
 */
export function renderedOperands(expr: string): readonly string[] {
  const text = peeled(expr);
  const parts = fallbackOperands(text);
  return parts.length === 1 ? [text] : parts.flatMap(renderedOperands);
}
