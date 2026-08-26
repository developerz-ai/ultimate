#!/usr/bin/env bun
// Enforce that ONE module in this tree turns a value into a SQL string literal.
// `literal()` in `packages/db/src/sql.ts` is that module; every other package imports it.
//
// THE DEFECT THIS EXISTS FOR. Three copies of the rule shipped, and two of them were wrong in the
// same way — they doubled the quote and stopped there. Doubling is only an escape while
// `standard_conforming_strings` is `on`. That GUC is settable per session, per database and per
// role, `SET` needs no privilege, and with it OFF a backslash escapes the character after it
// inside an ordinary `'…'`. Measured on PostgreSQL 18.4:
//
//   'dd' ~ '^\d+$'      -> FALSE with the GUC on, TRUE with it off (the server compiles ^d+$)
//   .default('C:\logs') -> stored default "C:\\logs" with it on, "C:logs" with it off
//
// So a CHECK enforced a pattern nobody wrote and a column defaulted to a value nobody wrote, with
// no error anywhere, at generation or at apply. A value ENDING in a backslash is worse: the
// escaped quote leaves the literal unterminated and the text after it is string data until the
// next `'` puts the remainder back into code position.
//
// `E'…'` fixes the dialect in the statement text instead of trusting a setting, and is emitted
// ONLY when the value carries a backslash — without one there is no escape mechanism for the two
// readings to disagree about, so every migration already on disk stays byte for byte what it was.
//
// WHY SHAPE, NEVER A NAME. The three copies were called `literal`, `literalText` and an inline
// `${v.replaceAll("'", "''")}` inside a template with no name at all. A rule spelled `literal`
// would have read straight past the third, exactly as a rule spelled `RenderMode` read past
// `PwaRenderMode` and a rule looking for a roll called `random` read past a parameter called `r`.
// What is matched is the TRANSFORMATION: a `replace`/`replaceAll` whose replacement is the
// two-single-quote string. That is the SQL escape and essentially nothing else.
//
// WHAT THIS CANNOT SEE. A producer that abandons escaping ALTOGETHER — `` `'${value}'` `` — doubles
// no quote, matches no rule here, and passes. This rule answers "is there a second copy of the
// escape", never "does every splice call one"; the second question has no static shape, so it is
// pinned by tests at the call sites instead (`packages/entity/src/expr.test.ts`, which fails when
// a producer stops calling `literal` at all). Naming the gap because a guard believed to be total
// is worse than one whose edge is written down.
//
// Pinned at ZERO, enforcing outright — the sweep landed first.
//
//   bun run sql-literal-copies  ·  bun run scripts/sql-literal-copies.ts [--json] [--explain]

import { collectSourceFiles, type SourceFile } from './boundaries';
import { parseScriptArgs } from './lib/args';
// Reused, never re-spelled: this file exists BECAUSE a rule written down three times was wrong
// twice. Blanking whole-line comments keeps the line count, so a reported position stays true.
import { stripComments } from './lib/i18n-scan';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'sql-literal-copies';

/** The one module allowed to spell the escape. Everything else imports what it exports. */
export const OWNER = 'packages/db/src/sql.ts';

/** Source the CLI EMITS rather than executes — a scaffolded app's own SQL, not this tree's. */
const TEMPLATE_ROOT = 'packages/cli/src/templates/';

/**
 * A `replace`/`replaceAll` whose REPLACEMENT is `''` — the SQL single-quote escape.
 *
 * The replacement is the discriminator, not the pattern: the pattern argument is spelled `"'"` in
 * most of this tree and `/'/g` where someone reached for a regex, while the replacement is the
 * doubled quote in every form. Both quoting styles are accepted because Biome writes `"''"` (a
 * string containing a quote takes double quotes) but a hand edit may not have.
 */
const DOUBLED_QUOTE = /\.replace(?:All)?\([^)]{0,48}?(?:"''"|'\\'\\''|`''`)/g;

export interface LiteralCopy {
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
}

/** Every site outside the owner that builds the escape itself. */
export function literalCopies(files: readonly SourceFile[]): readonly LiteralCopy[] {
  const found: LiteralCopy[] = [];
  for (const file of files) {
    if (file.path === OWNER || isTestPath(file.path) || file.path.startsWith(TEMPLATE_ROOT)) {
      continue;
    }
    // A comment DESCRIBING the escape is not an escape — this file's own header spells the call
    // it refuses, and so does the entity module that records why its copies were deleted.
    // `stripComments` preserves the LINE COUNT and not the character offsets — it blanks a comment
    // line rather than deleting it — so the position must be read from the masked source. Reading
    // it from the original reported line 2 for a call on line 27.
    const masked = stripComments(file.source);
    for (const match of masked.matchAll(DOUBLED_QUOTE)) {
      found.push({
        file: file.path,
        line: lineOf(masked, match.index),
        // The matched call, not the line: a line can be 100 columns of unrelated template.
        excerpt: match[0],
      });
    }
  }
  return found;
}

export interface LiteralCopyInput {
  readonly copies: readonly LiteralCopy[];
  /** Whether the owner itself was scanned. False means the rule read the wrong tree. */
  readonly ownerSeen: boolean;
}

export function checkLiteralCopies(input: LiteralCopyInput): readonly Finding[] {
  if (!input.ownerSeen) {
    return [
      {
        code: 'X_SQL_LITERAL_UNSCANNED',
        cause: `${OWNER} was not among the scanned files, so every copy of the escape would have read as absent`,
        fix: `restore ${OWNER}, or update OWNER in scripts/sql-literal-copies.ts if literal() moved — then bun run sql-literal-copies`,
        at: OWNER,
      },
    ];
  }
  return input.copies.map((copy) => {
    const at = `${copy.file}:${String(copy.line)}`;
    return {
      code: 'X_SQL_LITERAL_COPY',
      cause: `${at} builds a SQL string literal itself (${copy.excerpt}…), and doubling the quote is only half the escape — with standard_conforming_strings off a backslash escapes the character after it, so the statement means something the author never wrote`,
      fix: `import { literal } from '@ultimat3/db' and call it instead — it emits E'…' when the value carries a backslash, so both readings of the GUC agree. Take .text where a plain string is wanted. If this call is not building SQL, rename nothing and tell ${SCRIPT}: it matches the replacement "''", which is the SQL escape and essentially nothing else`,
      at,
    };
  });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const files = await collectSourceFiles(repoRoot());
  const copies = literalCopies(files);
  const ownerSeen = files.some((file) => file.path === OWNER);
  const findings = checkLiteralCopies({ copies, ownerSeen });
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${OWNER} is the one module that builds a SQL string literal, across ${String(files.length)} scanned file(s)`
          : findings[0]?.code === 'X_SQL_LITERAL_UNSCANNED'
            ? 'this rule read nothing, so no copy of the escape was checked'
            : `${String(findings.length)} site(s) building a SQL string literal outside ${OWNER}`,
      findings,
      data: { owner: OWNER, copies: args.flags.get('explain') === true ? copies : copies.length },
    },
    args.json,
  );
}
