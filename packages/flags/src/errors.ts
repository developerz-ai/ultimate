// The X_* codes owned by @ultimat3/flags. Each names the exact edit that resolves it.
// `X_FLAG_EXPIRED` is the odd one out on purpose: it is REPORTED to the error monitor, never
// thrown, because an overdue flag must become impossible to forget without taking production
// down with it — the branch keeps working, the debt stops being invisible.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const FLAGS_ERROR_CODES = [
  'X_FLAG_DUPLICATE',
  'X_FLAG_EXPIRED',
  'X_FLAG_EXPIRY_INVALID',
  'X_FLAG_SUBJECT_REQUIRED',
  'X_FLAG_TARGETING_INVALID',
  'X_FLAG_UNKNOWN',
] as const;

export type FlagsErrorCode = (typeof FLAGS_ERROR_CODES)[number];

export const FLAGS_ERROR_TITLES: Readonly<Record<FlagsErrorCode, string>> = {
  X_FLAG_DUPLICATE: 'two flags were declared with the same key',
  X_FLAG_EXPIRED: 'a temporary flag is past its expiry and is still being evaluated',
  X_FLAG_EXPIRY_INVALID: 'a temporary flag has no usable expiry date',
  X_FLAG_SUBJECT_REQUIRED: 'a flag decides by a subject the evaluation context does not carry',
  X_FLAG_TARGETING_INVALID: 'flag targeting is out of range or malformed',
  X_FLAG_UNKNOWN: 'no flag is declared under this key',
};

// Registered unconditionally at import, like every other package: a second package claiming one
// of these codes must surface as X_ERROR_CODE_DUPLICATE, never as a silent first-wins.
registerErrorCodes(
  Object.fromEntries(Object.entries(FLAGS_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class FlagsError extends UltimateError {
  override readonly name = 'FlagsError';

  constructor(init: {
    code: FlagsErrorCode;
    cause: string;
    fix: string;
    meta?: Readonly<Record<string, unknown>> | undefined;
  }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      meta: init.meta,
    });
  }
}

export const flagDuplicate = (key: string): FlagsError =>
  new FlagsError({
    code: 'X_FLAG_DUPLICATE',
    cause: `"${key}" is already declared, so one of the two declarations would decide nothing`,
    fix: `rename one of the two defineFlag({ key: '${key}' }) declarations`,
    meta: { key },
  });

export const flagUnknown = (key: string, known: readonly string[]): FlagsError =>
  new FlagsError({
    code: 'X_FLAG_UNKNOWN',
    cause: `"${key}" is not declared (${known.length} flags known), so it has no default, no owner and no expiry`,
    fix: `declare it with defineFlag({ key: '${key}', ... }), or correct the key at the isEnabled() call site`,
    meta: { key },
  });

/** `fix` is a parameter because a bad `bucketBy` is not repaired by editing `rollout` — axiom 4. */
export const flagTargetingInvalid = (key: string, problem: string, fix?: string): FlagsError =>
  new FlagsError({
    code: 'X_FLAG_TARGETING_INVALID',
    cause: `${key}: ${problem}`,
    fix: fix ?? `set rollout to an integer 0-100 in defineFlag({ key: '${key}' })`,
    meta: { key },
  });

/** Which targeting field asked for the subject, so the fix names an edit rather than a mechanism. */
export type FlagSubjectVia = 'orgs' | 'subjects' | 'bucketBy';

/**
 * Thrown, never softened into a fallback. Answering a subject-scoped flag from the actor axis — or
 * from the declared default — is the exact failure the subject axis exists to remove: it looks
 * like it worked, and the record finds out when half of it is on a different code path.
 *
 * The fix differs by kind because the edit does: a missing org is repaired where the actor is
 * minted, a missing record is repaired at the call site that already holds it.
 */
export const flagSubjectRequired = (init: {
  key: string;
  kind: string;
  actorId: string;
  via: FlagSubjectVia;
}): FlagsError =>
  new FlagsError({
    code: 'X_FLAG_SUBJECT_REQUIRED',
    cause: `${init.key} decides by the "${init.kind}" subject (targeting.${init.via}) but the evaluation context carries no ${init.kind} id for actor "${init.actorId}", so there is nothing to decide about`,
    // Every app-supplied string goes through JSON.stringify, and the kind becomes a COMPUTED key:
    // a `bank-integration` kind — the realistic shape, next to treasury's `bank_integration:` ids
    // — is not a valid identifier, so `{ bank-integration: … }` would hand the reader a fix that
    // does not parse. Axiom 4: an instruction that cannot be run is not one.
    fix:
      init.kind === 'org'
        ? `mint the actor with its tenant — userActor({ id: ${JSON.stringify(init.actorId)}, orgId: '<org>' }) — before the isEnabled(${JSON.stringify(init.key)}) call, or drop ${init.via} from defineFlag({ key: ${JSON.stringify(init.key)} })`
        : `pass the record at the call site — isEnabled(${JSON.stringify(init.key)}, actor, { [${JSON.stringify(init.kind)}]: '<id>' }) — or drop the ${JSON.stringify(init.kind)} ${init.via} entry from defineFlag({ key: ${JSON.stringify(init.key)} })`,
    meta: { key: init.key, kind: init.kind, actorId: init.actorId, via: init.via },
  });

/**
 * `JSON.stringify` throws on a bigint or a cycle, and RUNS a `toJSON` the value carries — so an
 * app object can hijack an error constructor with its own throw, and the caller then catches
 * something that is not `X_FLAG_EXPIRY_INVALID`. A cause only has to describe, so a value that
 * defeats rendering degrades to its type rather than destroying the refusal.
 */
export const renderGiven = (given: unknown): string => {
  if (given === undefined) return 'undefined';
  if (typeof given === 'bigint') return `${given}n`;
  if (typeof given === 'symbol') return String(given);
  try {
    return JSON.stringify(given) ?? String(given);
  } catch {
    return `a ${typeof given} that cannot be rendered`;
  }
};

export const flagExpiryInvalid = (key: string, given: unknown): FlagsError =>
  new FlagsError({
    code: 'X_FLAG_EXPIRY_INVALID',
    cause: `${key} is a temporary flag whose expiresAt is ${renderGiven(given)}, which is not a date`,
    fix: `set expiresAt to an ISO-8601 date such as '2026-12-01' in defineFlag({ key: '${key}' })`,
    meta: { key },
  });

/** Built, handed to the reporter, and never thrown. See this file's header for why. */
export const flagExpired = (init: {
  key: string;
  owner: string;
  expiresAt: string;
  overdueDays: number;
}): FlagsError =>
  new FlagsError({
    code: 'X_FLAG_EXPIRED',
    cause: `${init.key} expired ${init.overdueDays} day(s) ago (${init.expiresAt}, owner ${init.owner}) and is still being evaluated`,
    fix: `delete the ${init.key} branch and its defineFlag() declaration, or move it to kind: 'permanent' if it is a real product switch`,
    meta: { key: init.key, owner: init.owner, expiresAt: init.expiresAt },
  });
