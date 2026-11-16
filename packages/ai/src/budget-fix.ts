// The ceiling an `X_AI_BUDGET_EXCEEDED` refusal hands back: the budget key the scope is declared
// under, the value that would have covered this request, and where that key is written. A ledger
// scope is not always the declaration's key name, so the mapping lives here, next to nothing else.

/** What `AiBudgetExceededError` carries, minus the code. */
export interface BudgetRefusal {
  readonly scope: string;
  readonly requested: number;
  readonly remaining: number;
  readonly limit: number;
  readonly unit?: string | undefined;
}

/**
 * Where each ledger scope is declared. `request` is two keys: `providerGateway({ budget })` writes
 * it as itself, and an `agent()` writes `tokensPerRun`, which arrives at the ledger as `request`.
 */
const DECLARED_ON: Readonly<Record<string, string>> = {
  request: 'providerGateway({ budget }) — on an agent() it is budget.tokensPerRun',
  tokensIn: 'the llm()/agent() declaration, or providerGateway({ budget })',
  costPerCall: 'the llm()/agent() declaration, or providerGateway({ budget })',
  costPerRun: 'the agent() declaration',
  actor: 'providerGateway({ budget }) — a ceiling over the whole window',
  org: 'providerGateway({ budget }) — a ceiling over the whole window',
};

/** `USD minor units` or `USD at scale 6`, as the money scopes word their unit. */
const MONEY_UNIT = /^([A-Z]{3}) (?:minor units|at scale (\d+))$/;

/** One refusal's ceiling, in the three parts its fix line names. */
export interface BudgetCeiling {
  /** The budget key the scope is declared under: `actor:<kind>:<id>` is `actor`. */
  readonly key: string;
  /** Already spent plus this request — the smallest value that lets this exact call through. */
  readonly value: string;
  /** Where that key is written. */
  readonly where: string;
}

export function budgetCeiling(refusal: BudgetRefusal): BudgetCeiling {
  const key = refusal.scope.split(':')[0] ?? refusal.scope;
  const needed = refusal.limit - refusal.remaining + refusal.requested;
  const money = refusal.unit === undefined ? null : MONEY_UNIT.exec(refusal.unit);
  const value =
    money === null
      ? String(needed)
      : `{ minor: ${needed}, currency: '${money[1]}'${money[2] === undefined ? '' : `, scale: ${money[2]}`} }`;
  // A scope comes off the ledger, so `constructor` must not reach the prototype: own keys only.
  const where = Object.hasOwn(DECLARED_ON, key) ? DECLARED_ON[key] : undefined;
  return { key, value, where: where ?? 'providerGateway({ budget })' };
}
