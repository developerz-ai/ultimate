// The helpers that live in exactly one module, and the SHAPE of a second implementation of each —
// or of a second import path: a re-export of a core helper from another package. Every row replaced
// copies that had already drifted — four HTML escape sets, three cookie readers, four
// `PgExecutor`s — and is enforced by `bun run flight-copies` (`X_HELPER_COPY`).

import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import type { Finding } from './log';
import { lineOf } from './source-scan';

export interface HelperSource {
  readonly at: string;
  readonly text: string;
}

/** Both views a rule may read: string contents blanked (`masked`) or kept (`stripped`). */
interface Views {
  readonly masked: string;
  readonly stripped: string;
}

export interface HelperHome {
  /** The exported name the copy should have imported. */
  readonly helper: string;
  /** The one module allowed to implement it. */
  readonly home: string;
  /** Offsets of every copy in a file — each rule decides which view it reads. */
  readonly find: (views: Views) => readonly number[];
  /** A copy is a second IMPLEMENTATION (the default) or a second import PATH — a re-export. */
  readonly copy?: 're-export';
}

const offsets = (text: string, pattern: RegExp): number[] =>
  [...text.matchAll(pattern)].map((match) => match.index);

/** Offsets of `first` that have `second` within `window` characters after them. */
const near = (text: string, first: RegExp, second: RegExp, window: number): number[] =>
  offsets(text, first).filter((index) => second.test(text.slice(index, index + window)));

/**
 * FNV-1a's offset basis and prime, as VALUES: `0x811c_9dc5`, `2166136261` and `0x811C9DC5` are one
 * number, and a rule spelled on one of them reads straight past the other two.
 */
const FNV_CONSTANTS: ReadonlySet<number> = new Set([2_166_136_261, 16_777_619]);
const NUMERIC = /\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*)\b/g;
const fnvConstants = ({ masked }: Views): number[] =>
  [...masked.matchAll(NUMERIC)]
    .filter((match) => FNV_CONSTANTS.has(Number(match[0].replaceAll('_', ''))))
    .map((match) => match.index);

/** A replacement that WRITES `&amp;` — a map value or a replace argument — never one that reads it. */
const AMP_WRITTEN = /[:,]\s*(['"`])&amp;\1/g;

/** The `PgExecutor` method DECLARED (`;`), never implemented (`{`) — a test fake is the latter. */
const PG_EXECUTOR_METHOD =
  /\bquery\s*<\s*\w+\s*>\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*readonly\s+unknown\s*\[\s*\]\s*\)\s*:\s*Promise\s*<\s*readonly\s+\w+\s*\[\s*\]\s*>\s*;/g;

/** `export { … } from '@ultimat3/core'` — the stripped view, because the specifier is a string. */
const CORE_REEXPORT = /\bexport\s*\{([^}]*)\}\s*from\s*(['"])@ultimat3\/core\2/g;

/**
 * Offsets of `helper` as a VALUE inside a re-export of `@ultimat3/core` — `type helper` is a type,
 * and `helper as other` is still the helper. Only the package specifier counts: core's own barrel
 * re-exports from relative paths, which is the one home publishing its helper.
 */
const coreReexport =
  (helper: string) =>
  ({ stripped }: Views): number[] => {
    const found: number[] = [];
    for (const match of stripped.matchAll(CORE_REEXPORT)) {
      const list = match[1] ?? '';
      const start = match.index + match[0].indexOf('{') + 1;
      for (const spec of list.matchAll(/[^,]+/g)) {
        const name = /^\s*(type\s+)?([\w$]+)/.exec(spec[0]);
        if (name === null || name[1] !== undefined || name[2] !== helper) continue;
        found.push(start + spec.index + spec[0].indexOf(helper));
      }
    }
    return found;
  };

/**
 * The core VALUES `@ultimat3/action` and `@ultimat3/query` used to re-export "so no import moves":
 * client flight (one pipeline, `client-flight.ts`), the fence's reader, and the one audit-sink
 * slot. A re-export is a second import path for one value, which is axiom 1's tax on every reader.
 */
const CORE_REEXPORTED: readonly (readonly [helper: string, home: string])[] = [
  ['createClientFlight', 'packages/core/src/client-flight.ts'],
  ['DEFAULT_CLIENT_RETRY', 'packages/core/src/client-flight.ts'],
  ['isTransientFailure', 'packages/core/src/client-flight.ts'],
  ['isSuperseded', 'packages/core/src/generation-fence.ts'],
  ['getAuditSink', 'packages/core/src/audit.ts'],
  ['setAuditSink', 'packages/core/src/audit.ts'],
  ['resetAuditSink', 'packages/core/src/audit.ts'],
];

export const HELPER_HOMES: readonly HelperHome[] = [
  { helper: 'fnv1a', home: 'packages/core/src/fnv1a.ts', find: fnvConstants },
  {
    helper: 'fingerprint',
    home: 'packages/core/src/canonical-json.ts',
    // UNKEYED: one argument. `CryptoHasher('sha256', key)` over canonicalJson is an HMAC —
    // `keyedFingerprint`, the persisted form, a different helper with its own reason to exist.
    find: ({ masked }) =>
      near(masked, /\bCryptoHasher\s*\(\s*[^,()]*\)/g, /\bcanonicalJson\s*\(/, 200),
  },
  {
    helper: 'contentHash',
    home: 'packages/render/src/render-static.ts',
    // `stripped`: the copy in `revalidated-response.ts` sat inside a template literal's `${…}`,
    // which the masked view blanks along with the string around it.
    find: ({ stripped }) => offsets(stripped, /\bhash\s*\.\s*xxHash32\s*\(/g),
  },
  {
    helper: 'escapeHtml',
    home: 'packages/core/src/html-escape.ts',
    find: ({ stripped }) => offsets(stripped, AMP_WRITTEN),
  },
  {
    helper: 'readCookie',
    home: 'packages/core/src/cookie.ts',
    // The `name=value` walk itself, decoded or not: the two tier-2 copies decoded in a helper
    // further down the file, so a rule demanding `decodeURIComponent` beside the split read past both.
    find: ({ stripped }) =>
      near(
        stripped,
        /\.split\(\s*(['"`]);\1\s*\)/g,
        /\.indexOf\(\s*(['"`])=\1\s*\)|\bdecodeURIComponent\s*\(/,
        300,
      ),
  },
  {
    helper: 'PgExecutor',
    home: 'packages/core/src/pg-executor.ts',
    find: ({ masked }) => [
      ...offsets(masked, /\b(?:interface|type)\s+PgExecutor\b/g),
      ...offsets(masked, PG_EXECUTOR_METHOD),
    ],
  },
  {
    helper: 'storeMode',
    home: 'packages/core/src/store-mode.ts',
    // `stripped`, so a scaffold TEMPLATE writing the ternary into a generated app is caught too.
    find: ({ stripped }) =>
      offsets(stripped, /\bresolveEnvironment\s*\([^)]*\)\s*===\s*(['"`])test\1\s*\?/g),
  },
  {
    helper: 'renderDeprecation',
    home: 'packages/core/src/deprecation.ts',
    // `stripped`: both signals are string CONTENTS — the RFC 8288 relation the successor link
    // carries, and RFC 9745's `@<unix seconds>` Date. action and query each carried a twin of it.
    find: ({ stripped }) => [
      ...offsets(stripped, /\brel\s*=\s*\\?["']?successor-version\b/g),
      ...offsets(stripped, /`@\$\{\s*Math\s*\.\s*floor\s*\(/g),
    ],
  },
  ...CORE_REEXPORTED.map(
    ([helper, home]): HelperHome => ({
      helper,
      home,
      find: coreReexport(helper),
      copy: 're-export',
    }),
  ),
];

const finding = (file: HelperSource, rule: HelperHome, index: number): Finding => {
  const from = rule.home.startsWith('packages/core/')
    ? '@ultimat3/core'
    : '@ultimat3/render/server';
  const line = lineOf(file.text, index);
  return rule.copy === 're-export'
    ? {
        code: 'X_HELPER_COPY',
        cause: `${file.at}:${line} is a second ${rule.helper} — a re-export of ${from}'s, so one value has two import paths; ${rule.home} is its one home`,
        fix: `import { ${rule.helper} } from '${from}' at every caller and delete the re-export in ${file.at}`,
        at: file.at,
      }
    : {
        code: 'X_HELPER_COPY',
        cause: `${file.at}:${line} is a second ${rule.helper} — ${rule.home} is its one implementation, and copies of it had already drifted apart`,
        fix: `import { ${rule.helper} } from '${from}' and delete the local implementation in ${file.at}`,
        at: file.at,
      };
};

/**
 * One finding per helper per file, at its first copy, in source order: a basis and a prime two
 * lines apart are ONE FNV-1a, and the fix — import the helper, delete the local one — is per file.
 * A rule's own home is never reported.
 */
export function checkHelperHomes(file: HelperSource): readonly Finding[] {
  const views: Views = { masked: maskLiterals(file.text), stripped: stripComments(file.text) };
  const hits: { readonly rule: HelperHome; readonly index: number }[] = [];
  for (const rule of HELPER_HOMES) {
    if (rule.home === file.at) continue;
    const found = rule.find(views);
    if (found.length > 0) hits.push({ rule, index: Math.min(...found) });
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => finding(file, hit.rule, hit.index));
}
