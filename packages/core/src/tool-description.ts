// The ONE description a projected tool carries: `@ultimat3/mcp`'s, `@ultimat3/ai`'s and
// `@ultimat3/admin`'s, which the tier table keeps apart, so the rule lives here, never copied.

import { describeDeclaredErrors } from './declared-errors';

/** What a tool's description is read from — an action's, a query's, or a hand-built primitive's. */
export interface ToolDescriptionSource {
  readonly name: string;
  readonly description?: string;
  readonly mcp?: { readonly description?: string };
  /** `false` for a read (a query). Absent counts as a write, as `toolFrom` meters it. */
  readonly mutates?: boolean;
}

/**
 * `mcp.description`, else the primitive's own `description`, else a default naming it — a read
 * says it reads, so an agent never plans a write around one — then the declared `errors:`
 * appended (`describeDeclaredErrors`), so an agent plans around a refusal.
 */
export function toolDescription(source: ToolDescriptionSource, errors?: readonly string[]): string {
  const lead = source.mcp?.description ?? source.description ?? defaultLead(source);
  return describeDeclaredErrors(lead, errors);
}

function defaultLead(source: ToolDescriptionSource): string {
  return source.mutates === false
    ? `Read with the "${source.name}" query.`
    : `Run the "${source.name}" action.`;
}
