// Where a pending MCP confirmation lives between the agent's call and a human's decision: the row,
// the store contract both drivers answer, and the memory driver. Postgres is
// `confirmation-postgres.ts`; `confirmation-store.contract.test.ts` holds the two to one answer.

/** `pending` until a human decides; a decision is final. Expiry and consumption are timestamps. */
export type McpConfirmationStatus = 'pending' | 'approved' | 'rejected';

/**
 * One call an agent made that a human has to confirm: WHO asked, WHICH tool, and WHAT with — the
 * arguments SEALED (never plaintext at rest) so the person deciding sees exactly what they approve,
 * and their keyed digest, which the approval must match.
 */
export interface McpConfirmation {
  readonly id: string;
  /** The asking agent actor's id. */
  readonly actorId: string;
  /** Its org, so an app's `check` can keep a decision inside the tenant. `null` when it has none. */
  readonly orgId: string | null;
  readonly tool: string;
  /**
   * `keyedFingerprint` of the validated arguments (`h1:<key id>:<HMAC>`) — keyed because it is stored.
   * The approval binds to it; a rotated signing secret makes the same call a new confirmation.
   */
  readonly inputDigest: string;
  /** The validated arguments as JSON, `seal()`ed for `MCP_CONFIRMATION_ARGUMENTS_PURPOSE`. */
  readonly sealedArguments: string;
  readonly status: McpConfirmationStatus;
  readonly createdAt: Date;
  /** After this instant the row can be neither decided nor used. */
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  /** The deciding actor's id: the rejecter, or the approver whose vote met the quorum. */
  readonly decidedBy: string | null;
  /** Distinct approvals this row needs, resolved from `approvers({ args })` when it opened. */
  readonly quorum: number;
  /**
   * The `approvers` selectors (`actor:<id>`, `role:<name>`) resolved when it opened; `null` when
   * none were declared, and any decider the policy admits may approve.
   */
  readonly approvers: readonly string[] | null;
  /** One entry per distinct approver, in order — the stored evidence a separate process verifies. */
  readonly approvals: readonly McpConfirmationApproval[];
  /**
   * When the asking agent's next identical call took the outcome — ran it, or was told it was
   * rejected or expired. A consumed row is history: the same call afterwards asks again.
   */
  readonly consumedAt: Date | null;
}

/** One approver's vote: who, when, and their signature over the row's signing payload. */
export interface McpConfirmationApproval {
  readonly approver: string;
  readonly at: Date;
  /** `null` when `mcpConfirmations({ evidence })` is not declared. */
  readonly signature: string | null;
}

/** Optional so a row opened without `approvers` needs neither: one approval, any admitted decider. */
export type McpConfirmationDraft = Partial<Pick<McpConfirmation, 'quorum' | 'approvers'>> &
  Pick<
    McpConfirmation,
    | 'id'
    | 'actorId'
    | 'orgId'
    | 'tool'
    | 'inputDigest'
    | 'sealedArguments'
    | 'createdAt'
    | 'expiresAt'
  >;

export interface McpConfirmationStore {
  /**
   * The OPEN (unconsumed) row for this actor + org + tool + digest, or a new pending one built from
   * `draft` when there is none — atomically, so two identical calls racing open ONE row.
   */
  open(draft: McpConfirmationDraft): Promise<{ row: McpConfirmation; created: boolean }>;
  get(id: string): Promise<McpConfirmation | undefined>;
  /**
   * Pending, unconsumed and unexpired at `at`, as ONE conditional write. `rejected` settles the row.
   * `approved` appends `by`'s vote — refused when `by` already voted — and flips the row to
   * `approved` only when the votes reach its `quorum`. `undefined` when the row is not in that state
   * (or does not exist): a vote is taken once, and the caller re-reads to say why.
   */
  decide(
    id: string,
    status: 'approved' | 'rejected',
    by: string,
    at: Date,
    signature: string | null,
  ): Promise<McpConfirmation | undefined>;
  /** Unconsumed → consumed at `at`. `false` when another call took it first. */
  consume(id: string, at: Date): Promise<boolean>;
  /** Delete every row that expired before `before`, and answer how many — run it from a `task`. */
  purge(before: Date): Promise<number>;
}

/** The org is in the key: an actor id the same in two orgs is two callers, as Postgres' index. */
const openKey = (
  row: Pick<McpConfirmation, 'actorId' | 'orgId' | 'tool' | 'inputDigest'>,
): string => JSON.stringify([row.actorId, row.orgId, row.tool, row.inputDigest]);

/**
 * Per PROCESS: right for a test and for `x dev`, and a lie for a fleet — an agent's call opens the
 * row on one replica and a human's approval lands on another. A deployment passes
 * `postgresConfirmationStore({ executor })`.
 */
export function memoryConfirmationStore(): McpConfirmationStore {
  const rows = new Map<string, McpConfirmation>();
  /** open-key → id of the row no call has consumed yet. At most one per key, as Postgres' index. */
  const open = new Map<string, string>();
  const put = (row: McpConfirmation): McpConfirmation => {
    rows.set(row.id, row);
    return row;
  };
  return {
    async open(draft) {
      const existing = open.get(openKey(draft));
      const held = existing === undefined ? undefined : rows.get(existing);
      if (held !== undefined) return { row: held, created: false };
      const row = put({
        ...draft,
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        consumedAt: null,
        quorum: draft.quorum ?? 1,
        approvers: draft.approvers ?? null,
        approvals: [],
      });
      open.set(openKey(row), row.id);
      return { row, created: true };
    },
    async get(id) {
      return rows.get(id);
    },
    async decide(id, status, by, at, signature) {
      const row = rows.get(id);
      if (row === undefined || row.status !== 'pending' || row.consumedAt !== null)
        return undefined;
      if (row.expiresAt.getTime() <= at.getTime()) return undefined;
      if (status === 'rejected') return put({ ...row, status, decidedBy: by, decidedAt: at });
      if (row.approvals.some((one) => one.approver === by)) return undefined;
      const approvals = [...row.approvals, { approver: by, at, signature }];
      const met = approvals.length >= row.quorum;
      return put({
        ...row,
        approvals,
        ...(met ? { status: 'approved' as const, decidedBy: by, decidedAt: at } : {}),
      });
    },
    async consume(id, at) {
      const row = rows.get(id);
      if (row === undefined || row.consumedAt !== null) return false;
      put({ ...row, consumedAt: at });
      open.delete(openKey(row));
      return true;
    },
    async purge(before) {
      let purged = 0;
      for (const row of [...rows.values()]) {
        if (row.expiresAt.getTime() >= before.getTime()) continue;
        rows.delete(row.id);
        // An unconsumed row IS its key's open row: `open` holds exactly the unconsumed one per key.
        if (row.consumedAt === null) open.delete(openKey(row));
        purged += 1;
      }
      return purged;
    },
  };
}
