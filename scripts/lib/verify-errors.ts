// The `errors` step's host half, as one module: the reference page every shipped `X_*`
// code must appear on, and the rules that hold that page to its contract.
//
// It lives beside `scripts/verify.ts` rather than inside it because that file is the GATE — the
// step list's wiring, the boundary rules and the CLI's own entry — and this is one step's rules.
// The split is a split of RESPONSIBILITY, not of code: the same checks, the same findings, the
// same step.
//
// It is under `scripts/lib/` for the reason `scripts/lib/config-import.ts` and
// `scripts/lib/stability-findings.ts` are: `scripts/guards-doc.ts` reads a guard's row from its
// own text plus the `scripts/lib/*` modules it imports, one level down — so a rule that moved to
// a `scripts/*.ts` sibling would leave the `bun run verify` row under-reporting the guard.

import type { HostCheck } from '@ultimat3/cli';
import {
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  collectDeclaredCodes,
  registeredErrorCodes,
} from '@ultimat3/cli';
// The leaf, not the barrel (DX ledger #10): a guard must load while a package is mid-edit.
import { checkErrorCodesThrown } from '../../packages/cli/src/error-unthrown';
import { docFixFindings } from '../doc-fixes';
import { errorStatusCompleteness } from '../error-map';
import { errorRendering } from '../error-render';
import { fixProseFindings } from '../fix-prose';
import { bareErrorFindings } from '../test-bare-error';
import { testFixFindings } from '../test-fix-citations';
import { realSleepFindings } from '../test-real-sleep';
import { throwFindings } from '../to-throw-returns';

/**
 * The reference page every shipped `X_*` code must appear on. A framework monorepo publishes one
 * and a generated app does not, so naming it is the host's job — the CLI owns the rule, this repo
 * owns the file it is checked against.
 */
export const ERROR_REFERENCE = 'wiki/Error-Codes.md';

/**
 * The codes this repo's own gate emits. `scripts/` never ships, so no package may register
 * `X_ROADMAP_STATUS_MISSING` or `X_BOUNDARY_VIOLATION` — but the reference documents them, and a
 * rule that demanded a registration would push a contributor-only code into every generated app.
 * Scanned rather than listed, so a new script code needs no second edit here; a *documented* code
 * that neither a package nor a script declares is still the ghost row the registry check exists
 * to catch.
 *
 * The exemption follows the code's *declaration*, not every file that names it: a code a package
 * declares and a script merely throws — `X_BUN_VERSION` — is the package's to register, and
 * exempting it because `scripts/setup.ts` mentions it would waive the rule for a shipped code.
 */
const hostOwnedCodes = async (root: string): Promise<readonly string[]> =>
  (await collectDeclaredCodes(root))
    .filter((site) => site.at.startsWith('scripts/'))
    .map((site) => site.code);

/**
 * Both halves of the reference's contract, on one step. Every shipped code has a row here, and
 * every row this page presents as live resolves through `x errors explain` — the second half is
 * what stops the page documenting a code the registry never heard of.
 */
export const errorCodeDocs: HostCheck = async (root) => {
  const known = new Set([...(await registeredErrorCodes()), ...(await hostOwnedCodes(root))]);
  return [
    ...(await checkErrorCodeDocs(root, ERROR_REFERENCE)),
    ...(await checkErrorCodeRegistry(root, ERROR_REFERENCE, known)),
    ...(await checkErrorCodesThrown(root, ERROR_REFERENCE)),
  ];
};

/**
 * The `errors` step's host half: the reference page's three rules, the rule that an error factory
 * may not die formatting its own message, and the rule that `@ultimat3/http`'s status table stays
 * closed. Five rules on one step, the same shape `boundaries` already carries — a rule about
 * errors belongs on the errors step, not on an eighteenth one an agent has to learn the name of.
 *
 * `docFixFindings` is the reference page's THIRD rule and the one nothing enforced: the CLI's
 * `checkErrorFixes` resolves cited commands for `fix:` literals in shipped SOURCE, and the page an
 * agent is sent to when it hits a code was held to coverage and registration only. So a `Fix` cell
 * could print `x db query "select id …"` — and `x db` has no `query`, which is a second failure
 * handed to a reader already holding one.
 *
 * `testFixFindings`, `bareErrorFindings` and `throwFindings` join it because all three are the same
 * contract one file set further on. `checkErrorFixes` holds every `fix:` in `src/` to being runnable and skips tests, so a
 * fixture error, a helper that builds one and an assertion pinning a fix string were unchecked —
 * and `x schema show` and `x logs tail` are what that costs. `throwFindings` is the other half of
 * an error assertion: bun's synchronous `toThrow` PASSES when the callback returns an Error rather
 * than throwing one, and this repo exports 196 functions that return one. `bareErrorFindings` is the rule itself in
 * that file set: `CLAUDE.md` says never throw a bare `Error` and the enforced check skips tests, so
 * 422 sites sat under a green gate — a convention that is not a build error does not exist.
 * `fixProseFindings` holds the same `fix:` lines to OPENING with a command or a code shape, on a
 * per-package ratchet: the rule says a fix is a command, and 987 lines were sentences.
 *
 * The completeness rule is deliberately NOT its own step: `VerifyStepName` is a closed union owned
 * by `@ultimat3/cli`, and a generated app would inherit a step name that only this repo can run.
 * It blocks `x verify` either way, which is what "enforced, not documented" asks for.
 */
export const errorContract: HostCheck = async (root) => [
  ...(await errorCodeDocs(root)),
  ...(await errorRendering(root)),
  ...(await errorStatusCompleteness(root)),
  ...(await docFixFindings(root)),
  ...(await testFixFindings(root)),
  ...(await bareErrorFindings(root)),
  ...(await realSleepFindings(root)),
  ...(await throwFindings(root)),
  ...(await fixProseFindings(root)),
];
