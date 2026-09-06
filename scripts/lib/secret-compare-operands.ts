// The vocabulary `scripts/secret-compare.ts` reads, and the two walks that find an operand's text.
// Split out of the rule when it reached its 500-line ceiling: the rule owns what it does with a
// finding, this file owns what a secret-named operand IS. Data and text, no policy.
//
// Re-exported by name from `scripts/secret-compare.ts`, so the rule stays the one import a caller
// needs and no test has to learn where the split fell.

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
];

/**
 * The bare words, whole and case-insensitive. `state` is here because `oauth.ts:131` compares the
 * OAuth handshake `state` under that exact name; `candidate` and `digest` because `mfa.ts` calls a
 * recovery code and its hash that.
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

export const namesASecret = (operand: string): string | undefined =>
  [...operand.matchAll(IDENTIFIER)].map((one) => one[0]).find(isSecretName);

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
 */
const INERT = /^(?:undefined|null|true|false|-?\d|['"`])|\.length$/;

export const isInert = (operand: string): boolean => {
  const text = operand.trim();
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
