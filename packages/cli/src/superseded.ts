// The superseded-workaround table: what an app wrote while the framework lacked something, the
// version that shipped the real thing, and the edit that retires the workaround. `x doctor` and
// `x upgrade` report each hit (`doctor-superseded.ts`); `scripts/changelog-check.ts` refuses a
// release note that retires a workaround this table does not hold.

/**
 * What to find. `comment` is matched on comment text only — a `//`, `/*` or `*` line of code, any
 * line of markdown — and EVERY pattern must match one comment block: a workaround is recognised by
 * the note that names it, never by ordinary code. `near`, when set, must also stand in the code
 * within `NEAR_LINES` of that block: the note alone is stale prose, the note beside it is the
 * workaround still in force.
 */
export interface WorkaroundPattern {
  readonly comment: readonly RegExp[];
  readonly near?: RegExp;
}

export interface SupersededWorkaround {
  /** Stable, kebab-case: a CHANGELOG line names it (`retires the workaround \`<id>\``). */
  readonly id: string;
  readonly pattern: WorkaroundPattern;
  /** The framework version that shipped the replacement. */
  readonly shippedIn: string;
  /** What replaced it, as an author would search for it. */
  readonly replacement: string;
  /** Opens with the code or command to paste (the fix-prose rule). */
  readonly fix: string;
}

/** How far from its note the workaround's code may stand, in lines either way. */
export const NEAR_LINES = 8;

export const SUPERSEDED_WORKAROUNDS: readonly SupersededWorkaround[] = [
  {
    // The scaffold itself wrote this until 30.0.0: "'ssr', not 'stream' … the framework has no hole
    // marker yet". Apps kept the comment and the mode after the marker shipped.
    id: 'ssr-until-hole',
    pattern: { comment: [/\bhole\s+marker\b/i], near: /\brender\s*:\s*['"]ssr['"]/ },
    shippedIn: '30.0.0',
    replacement: "<Hole> from '@ultimat3/render' on a render: 'stream' page",
    fix: "render: 'stream', with the slow read moved into <Hole fallback={<Skeleton />}>{() => read()}</Hole> (import { Hole } from '@ultimat3/render'); then delete the comment that waits for a hole marker",
  },
  {
    // `x token` exited `X_NOT_IMPLEMENTED` until 31.17.0; a key-minting script said so in its header.
    id: 'token-unimplemented',
    pattern: {
      comment: [
        // Present tense only, and never `x token grant`, which is still planned: a changelog line
        // saying the command "exited X_NOT_IMPLEMENTED" is history, not a workaround.
        /\bx token`?(?! grant)\s+(?:\w+\s+){0,3}?(?:is|isn't|still|remains)\s+(?:not (?:yet )?(?:implemented|shipped|available)|unimplemented|planned|a stub)\b|\bx token`?(?! grant)[^.]*\bexits\s+`?X_NOT_IMPLEMENTED/i,
      ],
    },
    shippedIn: '31.17.0',
    replacement: 'x token create | list | revoke',
    fix: 'x token create --scopes posts:read --json — mints the key with exact scopes; delete the note, and the script it stood in for',
  },
  {
    // A gaps note saying the gate cannot run one step: `--only` shipped with the gate in 22.0.0.
    id: 'verify-no-only',
    pattern: {
      comment: [
        // The claim about the gate, never a fixture or a step that merely runs without the flag.
        /\b(?:verify|gate)`?\s+(?:has|have|takes|offers|supports)\s+no\s+`?--only\b|`--only`\s+(?:flag\s+)?(?:does not exist|doesn't exist|is missing|is not supported|isn't supported)/i,
      ],
    },
    shippedIn: '22.0.0',
    replacement: 'x verify --only <step>',
    fix: 'x verify --only lint --json — runs one step; delete the note that says the gate cannot',
  },
  {
    // A hand-written TLS terminator or relay in front of `x dev` for a LAN or a secure origin.
    id: 'dev-no-tls',
    pattern: {
      comment: [
        /\bx dev\b/,
        /\b(?:no|lacks|has no|does not|doesn't|cannot|can't|won't)\s+(?:\S+\s+){0,3}?`?(?:tls|https|--tls|--host|ipv6)\b/i,
      ],
    },
    shippedIn: '31.27.0',
    replacement: 'x dev --host <address> --tls',
    fix: 'x dev --host 0.0.0.0 --tls — serves https on the LAN with a cached local certificate; delete the terminator or relay the note describes',
  },
];
