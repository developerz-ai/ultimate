// The vocabulary `scripts/secret-compare.ts` reads, and the two walks that find an operand's text.
// Split out of the rule when it reached its 500-line ceiling: the rule owns what it does with a
// finding, this file owns what a secret-named operand IS. Data and text, no policy.
//
// Re-exported by name from `scripts/secret-compare.ts`, so the rule stays the one import a caller
// needs and no test has to learn where the split fell.

import { balancedClose } from './balanced-paren';
import { interpolates } from './template-interpolations';

/**
 * The camelCase SUFFIXES that make a comparison a credential check: `tokenHash`, `keyHash`,
 * `csrfToken`, `apiKey` and `mfaSecret` are each one of these wearing a prefix.
 */
export const SECRET_SUFFIXES: readonly string[] = [
  'Hash',
  'Secret',
  'Token',
  'Key',
  'Nonce',
  'Digest',
  'Mac',
  'Signature',
  'Verifier',
  'Candidate',
  'Password',
  'Otp',
  'Sig',
  'Hmac',
];

/**
 * The bare words, whole and case-insensitive. `state` is here because `oauth.ts:131` compares the
 * OAuth handshake `state` under that exact name; `candidate` and `digest` because `mfa.ts` calls a
 * recovery code and its hash that. `sig` and `hmac` (and their suffixes) since sweep 11: a webhook
 * signature is spelt that way at least as often as in full — measured, zero sites in this tree.
 */
export const SECRET_WORDS: readonly string[] = [
  'hash',
  'secret',
  'token',
  'nonce',
  'verifier',
  'signature',
  'candidate',
  'digest',
  'mac',
  'state',
  'password',
  'otp',
  'sig',
  'hmac',
];

/**
 * `tokenHash` yes, `sortKey` yes, `API_KEY` yes, `key` NO.
 *
 * The SUFFIX behind a boundary and the whole WORD, and deliberately not "contains `key`": measured,
 * a bare `key` matches 362 sites across 27 packages — a `Map` key, a sort key, a cache key, a
 * catalog key — and not one of `@ultimat3/auth`'s twelve `timingSafeEqual` call sites needs it.
 * `keyHash` and `apiKey` carry the capital, `API_KEY` carries the underscore. A vocabulary that
 * reds a whole tree is a vocabulary somebody deletes, and this rule only has to be narrow enough to
 * survive.
 */
const SECRET_SUFFIX = new RegExp(
  // camelCase, and the boundary is required: `[A-Za-z0-9]` before the capitalised suffix is what
  // separates `apiKey` from a bare `Key`, and the capital is what separates it from `monkey`.
  `[A-Za-z0-9](?:${SECRET_SUFFIXES.join('|')})$` +
    // SCREAMING_SNAKE is the SAME word — `SESSION_SECRET`, `API_KEY`, `DEV_SIGNING_SECRET` — and it
    // is the spelling a module-scope constant actually uses, which is where a signing secret lives.
    // The underscore is that form's boundary, so `KEY` alone is still nothing.
    `|_(?:${SECRET_SUFFIXES.map((suffix) => suffix.toUpperCase()).join('|')})$`,
);

/** The whole WORD, in any case — `secret`, `Secret`, `SECRET`, `OTP`. */
const SECRET_WORD = new RegExp(`^(?:${SECRET_WORDS.join('|')})s?$`, 'i');

const isSecretName = (name: string): boolean => SECRET_SUFFIX.test(name) || SECRET_WORD.test(name);

/** Every identifier in an operand's text — `sha256Hex(parsed.secret)` gives three. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * The first secret-named identifier in an operand. `element`, when given, is a name that is NOT one
 * here — an array predicate's own parameter (`predicateElementAt`) — and it is skipped as a bare
 * identifier only: `entry.candidate` is a property that happens to share the word.
 */
export const namesASecret = (operand: string, element?: string): string | undefined =>
  [...operand.matchAll(IDENTIFIER)].find(
    (one) => isSecretName(one[0]) && !(one[0] === element && operand[one.index - 1] !== '.'),
  )?.[0];

/** The one name a predicate's parameter is excused under. Every other secret word still reports. */
export const PREDICATE_ELEMENT = 'candidate';

/**
 * `.find((candidate) => …)` and its siblings — the array methods whose callback TESTS an element.
 * `map`, `forEach` and `reduce` are not here: they build or do, and what they compare is theirs.
 */
const PREDICATE_CALL = new RegExp(
  `\\.(?:find|findLast|findIndex|findLastIndex|filter|some|every)\\s*\\(\\s*\\(?\\s*${PREDICATE_ELEMENT}(?![\\w$])`,
  'g',
);

/**
 * Answers, for an offset in `code`, the name to excuse there: `candidate` inside the parentheses of
 * a predicate call whose first parameter is named that, nothing anywhere else.
 *
 * `candidate` is in the vocabulary for `mfa.ts`'s recovery code. As a predicate's parameter it is
 * the ELEMENT UNDER TEST — a route, a table, a waiter — and it was 20 of the tree's 22 `candidate`
 * sites, each one a sentence in the pins table saying "not a secret". Only the name is excused:
 * `codes.find((candidate) => candidate.hash === hash)` still reports, for `hash`.
 */
export function predicateElementAt(code: string): (at: number) => string | undefined {
  const spans: (readonly [number, number])[] = [];
  for (const match of code.matchAll(PREDICATE_CALL)) {
    const open = code.indexOf('(', match.index);
    const close = balancedClose(code, open);
    if (close !== -1) spans.push([open, close]);
  }
  return (at) =>
    spans.some(([open, close]) => at > open && at < close) ? PREDICATE_ELEMENT : undefined;
}

/**
 * An operand that carries no secret bytes, so the comparison against it leaks nothing: `undefined`,
 * `null`, a boolean, a number, a string LITERAL, or a `.length`.
 *
 * This is what separates a PRESENCE check from a credential check, and it is most of the difference
 * between a rule and a wall. Measured: without it 241 sites report across 25 packages and 32 of
 * them are in `@ultimat3/auth`, whose twelve real comparisons all already go through
 * `timingSafeEqual` — `if (token === null)`, `secret.length === 0`, `user.mfaSecret !== null`.
 * `x === undefined` cannot be walked byte by byte because there is no byte to walk: the operator
 * short-circuits on the type tag before any content is read.
 *
 * A string literal is read off `maskLiterals`' output, where the contents are blanked and the
 * QUOTES survive — which is exactly the property that makes `state === '     '` recognisable as a
 * comparison against a constant without this rule ever seeing what the constant said.
 *
 * A TEMPLATE is inert only when it interpolates nothing. The rule reads `withInterpolations`'
 * output, where a `${…}` body is code again, so `` `sha256=${hmac(body)}` `` is a value computed at
 * run time — until sweep 11 its opening backtick alone made it inert and the comparison vanished.
 */
const INERT = /^(?:undefined|null|true|false|-?\d|['"])|\.length$/;

export const isInert = (operand: string): boolean => {
  const text = operand.trim();
  if (text.startsWith('`')) return !interpolates(text) || /\.length$/.test(text);
  // EMPTY is inert, and it is the commonest case by far: the walk stops at the first character it
  // does not recognise, and a masked string literal opens with a quote — so `secret === ''` and
  // `typeof state !== 'string'` both hand back nothing on one side. Reading "unreadable" as
  // "suspicious" reported 100 comparisons against a constant, `record.state === 'running'` among
  // them. A literal is in the source; there is nothing to learn a byte at a time.
  return text === '' || INERT.test(text);
};

const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Backwards over one primary expression: identifiers, `.`, `?.`, and balanced `(…)` / `[…]`. */
export function operandBefore(code: string, at: number): string {
  let index = at - 1;
  while (index >= 0 && /\s/.test(code[index] as string)) index -= 1;
  const end = index + 1;
  while (index >= 0) {
    const char = code[index] as string;
    if (char === '`') {
      // A template, as `withInterpolations` writes it: no backtick survives inside one.
      const open = code.lastIndexOf('`', index - 1);
      if (open === -1) break;
      index = open - 1;
      continue;
    }
    if (Object.hasOwn(CLOSERS, char)) {
      const open = CLOSERS[char] as string;
      let depth = 0;
      for (; index >= 0; index -= 1) {
        const inner = code[index] as string;
        if (inner === char) depth += 1;
        else if (inner === open) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index -= 1;
      continue;
    }
    if (/[\w$.?!]/.test(char)) {
      index -= 1;
      continue;
    }
    break;
  }
  return code.slice(index + 1, end);
}

/** Forwards over one primary expression, the mirror of the walk above. */
export function operandAfter(code: string, from: number): string {
  let index = from;
  while (index < code.length && /\s/.test(code[index] as string)) index += 1;
  const start = index;
  while (index < code.length) {
    const char = code[index] as string;
    if (char === '`') {
      const close = code.indexOf('`', index + 1);
      index = close === -1 ? code.length : close + 1;
      continue;
    }
    if (Object.hasOwn(OPENERS, char)) {
      const close = OPENERS[char] as string;
      let depth = 0;
      for (; index < code.length; index += 1) {
        const inner = code[index] as string;
        if (inner === char) depth += 1;
        else if (inner === close) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index += 1;
      continue;
    }
    if (/[\w$.?!]/.test(char)) {
      index += 1;
      continue;
    }
    break;
  }
  return code.slice(start, index);
}
