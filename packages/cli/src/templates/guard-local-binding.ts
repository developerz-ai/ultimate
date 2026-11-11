// The source text of `bindsLocally()`, spliced into each shipped guard that refuses a call to a
// global by name (`confirm(`, `fetch(`, `setInterval(`): a file that declares its own binding of
// that name calls its own function, never the global. One copy here, so the three guards read a
// binding the same way. `String.raw` keeps the regexes as written; the text holds no backtick.

export const LOCAL_BINDING_SOURCE = String.raw`const DECLARED = /\b(?:const|let|var|class|function\s*\*?)\s+([A-Za-z_$][\w$]*)/g;
const ARROW_PARAMETER = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
const IMPORT_CLAUSE = /\bimport\s+([^;]*?)\bfrom\b/g;
/** A name an import clause binds: 'a', '{ a }', '* as a', '{ b as a }' — never the 'b' of 'b as a'. */
const IMPORTED = /(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])(?!\s+as\b)/g;
const IDENTIFIER = /(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])/g;
/** After a pattern's closing bracket: '=' closes a destructuring, '=>' or a body a parameter list. */
const PATTERN_END = /^\s*(?::[^=;{}()]*?)?\s*(=>|=(?!=)|\{)/;
const CONDITION = /\b(?:if|for|while|switch|with)\s*$/;
const OPENERS = '([{';
const CLOSERS = ')]}';

/** The index of the bracket closing the one at 'open', or the end of the text. */
const closing = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (OPENERS.includes(text[index] ?? '')) depth += 1;
    if (CLOSERS.includes(text[index] ?? '') && --depth === 0) return index;
  }
  return text.length;
};

/** The brackets enclosing 'at', innermost first, up to and including the first parenthesis. */
const enclosing = (text: string, at: number): readonly number[] => {
  const opens: number[] = [];
  let depth = 0;
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index] ?? '';
    if (CLOSERS.includes(char)) depth += 1;
    else if (OPENERS.includes(char) && depth > 0) depth -= 1;
    else if (OPENERS.includes(char)) {
      opens.push(index);
      if (char === '(') break;
    }
  }
  return opens;
};

/** Whether the occurrence at 'at' sits in a parameter list or a destructuring pattern. */
const inPattern = (text: string, at: number, name: string): boolean => {
  const opens = enclosing(text, at);
  // '{ name: other }' binds 'other', and '(name: Type)' is a parameter: a key only in braces.
  if (text[opens[0] ?? -1] === '{' && /^\s*:/.test(text.slice(at + name.length))) return false;
  for (const open of opens) {
    const close = closing(text, open);
    const end = PATTERN_END.exec(text.slice(close + 1, close + 200))?.[1];
    if (end === undefined) continue;
    if (text[open] !== '(') return end === '=';
    return end !== '=' && !CONDITION.test(text.slice(Math.max(0, open - 10), open));
  }
  return false;
};

/**
 * Whether the file binds 'name' itself — declared, imported, a parameter or destructured — so a
 * bare 'name(' is its own function and not the global. File-wide, not scoped: a guard is a regex.
 */
const bindsLocally = (text: string, name: string): boolean => {
  for (const match of text.matchAll(DECLARED)) if (match[1] === name) return true;
  for (const match of text.matchAll(ARROW_PARAMETER)) if (match[1] === name) return true;
  for (const clause of text.matchAll(IMPORT_CLAUSE)) {
    for (const match of (clause[1] ?? '').matchAll(IMPORTED)) if (match[1] === name) return true;
  }
  for (const match of text.matchAll(IDENTIFIER)) {
    if (match[0] !== name || /^\s*\(/.test(text.slice(match.index + name.length))) continue;
    if (inPattern(text, match.index, name)) return true;
  }
  return false;
};`;
