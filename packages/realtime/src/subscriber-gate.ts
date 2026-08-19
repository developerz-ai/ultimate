// The per-subscriber pass of a definition's row policy over the shared window, and the two numbers
// it produces: rows denied, and gates that could not decide. It evaluates no policy of its own —
// `policy-gate.ts` is this package's only authz seam — it calls `LiveQueryDefinition.visible` and
// classifies what comes back, so a denial and a failure never arrive as the same event.

import type { Actor } from '@ultimat3/core';
import { isPolicyDenial } from './errors';
import type { JsonValue, Row, RowPatch } from './json';
import type { LiveQueryDefinition } from './live-contract';

/**
 * Who a decision is being made for. Every policy call in the live pipeline takes one, which is the
 * shape of the rule: there is no path through the gate that reads a query id and no actor.
 */
export interface Subscriber {
  readonly sid: string;
  readonly actor: Actor | null;
}

/** One row withheld from one subscriber. Carries no row payload: the ids are the whole point. */
export interface RowDenied {
  readonly qid: string;
  readonly sid: string;
  readonly actorId: string | null;
  readonly rowId: string;
}

/** Where a gate was standing when it failed. `authorize` is subscribe-time, the rest are rows. */
export type GateStage = 'authorize' | 'snapshot' | 'patch';

/**
 * One gate that raised something other than a denial. `rowId` is absent for `authorize`, which
 * decides about a subscription rather than a row, and `error` is passed through unwrapped so the
 * node logs the driver's own message instead of a summary of it.
 */
export interface GateFailed {
  readonly qid: string;
  readonly sid: string;
  readonly actorId: string | null;
  readonly stage: GateStage;
  readonly rowId?: string;
  readonly error: unknown;
}

/**
 * What the gate needs from a query entry and nothing more: the shared pre-policy window, the input
 * the rules read, and the definition that owns `visible`. `QueryEntry` satisfies it structurally,
 * so the registry passes its entry straight through and this file never learns what else is on it.
 */
export interface GateTarget {
  readonly qid: string;
  readonly input: JsonValue;
  readonly definition: LiveQueryDefinition;
  readonly rows: readonly Row[];
}

export interface SubscriberGateOptions {
  /**
   * `live.rows_denied`. A row an actor's policy refuses is dropped, never sent and never turned
   * into an error — telling a client "there is a row you may not see" is itself the leak. Dropped
   * silently it is also invisible, so the drop is a metric instead.
   */
  readonly onRowDenied?: (event: RowDenied) => void;
  /**
   * `live.gate_failed`. The gate raised something that is not a decision, so this subscriber's
   * result set is unknown rather than empty. Separate from `onRowDenied` on purpose: an alert
   * fires on this one, and a dashboard that summed them would show a permission change.
   */
  readonly onGateFailed?: (event: GateFailed) => void;
}

/** Both counters and the one call that classifies a throw. Owned per registry, never per query. */
export class SubscriberGate {
  readonly #options: SubscriberGateOptions;
  #rowsDenied = 0;
  #gateFailures = 0;

  constructor(options: SubscriberGateOptions) {
    this.#options = options;
  }

  /** Rows a subscriber's policy refused since boot. */
  get rowsDenied(): number {
    return this.#rowsDenied;
  }

  /** Gates that raised instead of deciding since boot. */
  get gateFailures(): number {
    return this.#gateFailures;
  }

  /**
   * One snapshot, filtered for one subscriber. A failure raises rather than returning the rows it
   * managed to admit: a short result set is indistinguishable from a correct one, and handing it
   * over is the read silently losing rows.
   */
  async filterRows(target: GateTarget, who: Subscriber, rows: readonly Row[]): Promise<Row[]> {
    const out: Row[] = [];
    for (const row of rows) {
      if (await this.#visible(target, who, row, 'snapshot')) out.push(row);
      else this.#denied(target.qid, who, row.id);
    }
    return out;
  }

  /**
   * Row-level authz over a patch list. A row that becomes invisible is converted to a `delete`
   * when the subscriber holds it — otherwise a revoked grant would leave a stale row on screen
   * forever.
   */
  async filterPatches(
    target: GateTarget,
    who: Subscriber,
    patches: readonly RowPatch[],
    held: ReadonlySet<string>,
  ): Promise<RowPatch[]> {
    const out: RowPatch[] = [];
    for (const patch of patches) {
      const allowed = await this.patch(target, who, patch, held.has(patch.id));
      if (allowed !== null) out.push(allowed);
    }
    return out;
  }

  /** One patch, one decision. `holds` is whether this subscriber already has the row on screen. */
  async patch(
    target: GateTarget,
    who: Subscriber,
    patch: RowPatch,
    holds: boolean,
  ): Promise<RowPatch | null> {
    // A delete carries no row, so there is nothing to put in front of the rule — `holds` IS the
    // decision, the same one the two branches below take for a row a rule has just refused.
    // Returned unconditionally it was a leak with no upper bound: the shared window is pre-policy,
    // so every subscriber learned the id and the instant of every OTHER tenant's row as it was
    // deleted, on a query whose `visible` rule had never let them see one of them.
    //
    // `holds` comes from `subscription.cursor.ids`, truncated at `CURSOR_ID_LIMIT` — so on a window
    // wider than 512 rows a legitimate delete past position 512 is dropped and that row stays on
    // screen until the subscriber re-snapshots. That is the trade the denied-update branch below
    // already makes, and it is the right way round: a stale row is a bug, a row id leaked to
    // another tenant is a breach.
    if (patch.op === 'delete' || patch.row === null) {
      if (holds) return patch;
      // Counted, or a withheld delete is invisible in exactly the way `onRowDenied` exists to
      // stop — and the rate of it is how an operator sees a window shared across tenants at all.
      this.#denied(target.qid, who, patch.id);
      return null;
    }
    const full = target.rows.find((row) => row.id === patch.id);
    // No whole row means no decision to take. An update patch carries the changed columns only, so
    // a rule reading `row.ownerId` on one reads `undefined` and answers as if the row had said so —
    // fail-closed for `=== actor.id`, and a leak for every `!row.private`. It is not a gate that
    // failed either: the shared window *is* the result set, so a row it does not hold is a row this
    // subscriber is not entitled to keep, and one that holds it is told so.
    if (full === undefined) return holds ? withdrawn(patch) : null;
    const row: Row = { ...full, ...patch.row, id: patch.id };
    if (await this.#visible(target, who, row, 'patch')) return patch;
    this.#denied(target.qid, who, patch.id);
    return holds ? withdrawn(patch) : null;
  }

  /**
   * `authorize` failed for a subscription that is being re-decided. Counted and reported here so
   * every gate failure in the pipeline goes through one counter, whatever the caller then does
   * with the subscription.
   */
  failedAuthorize(qid: string, who: Subscriber, error: unknown): void {
    this.#failed(qid, who, 'authorize', undefined, error);
  }

  /** The definition's own predicate. A denial answers `false`; anything else is counted and raised. */
  async #visible(
    target: GateTarget,
    who: Subscriber,
    row: Row,
    stage: GateStage,
  ): Promise<boolean> {
    try {
      return await target.definition.visible({ actor: who.actor, row, input: target.input });
    } catch (error) {
      if (isPolicyDenial(error)) return false;
      this.#failed(target.qid, who, stage, row.id, error);
      throw error;
    }
  }

  /** `live.rows_denied`. Counted here and nowhere else, so every drop is one increment. */
  #denied(qid: string, who: Subscriber, rowId: string): void {
    this.#rowsDenied += 1;
    this.#options.onRowDenied?.({ qid, sid: who.sid, actorId: actorIdOf(who), rowId });
  }

  /** `live.gate_failed`. Same rule: one place counts, so the number and the events agree. */
  #failed(
    qid: string,
    who: Subscriber,
    stage: GateStage,
    rowId: string | undefined,
    error: unknown,
  ): void {
    this.#gateFailures += 1;
    this.#options.onGateFailed?.({
      qid,
      sid: who.sid,
      actorId: actorIdOf(who),
      stage,
      ...(rowId === undefined ? {} : { rowId }),
      error,
    });
  }
}

const actorIdOf = (who: Subscriber): string | null => (who.actor === null ? null : who.actor.id);

/**
 * The one frame a subscriber gets for a row it may no longer keep, whether a rule refused it or the
 * window stopped holding it. Written once so the two paths cannot answer differently: a client left
 * holding the row instead renders a revoked grant until something else reconnects it.
 */
const withdrawn = (patch: RowPatch): RowPatch => ({
  op: 'delete',
  id: patch.id,
  row: null,
  lsn: patch.lsn,
});
