// The per-subscriber pass of a definition's row policy over the shared window, and the two numbers
// it produces: rows denied, and gates that could not decide. It evaluates no policy of its own —
// `policy-gate.ts` is this package's only authz seam — it calls `LiveQueryDefinition.visible` and
// classifies what comes back, so a denial and a failure never arrive as the same event.

import type { Actor } from '@ultimat3/core';
import { isPolicyDenial } from './errors';
import type { JsonValue, Row, RowPatch } from './json';
import type { LiveQueryDefinition } from './live-query';

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
    if (patch.op === 'delete' || patch.row === null) return patch;
    // The policy always sees the whole row from the shared window — a patch carries changed
    // columns only, and authorizing a partial row is how a row policy silently starts failing.
    const full = target.rows.find((row) => row.id === patch.id);
    const row: Row = { ...(full ?? {}), ...patch.row, id: patch.id };
    if (await this.#visible(target, who, row, 'patch')) return patch;
    this.#denied(target.qid, who, patch.id);
    return holds ? { op: 'delete', id: patch.id, row: null, lsn: patch.lsn } : null;
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
