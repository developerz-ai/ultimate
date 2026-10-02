// What a write is handed, made safe to judge: sealed values split around the entity's schema, the
// tenant column taken out of the caller's hands, and the audit diff of what the write changed.
// Pure over the resource — `crud.ts` decides and writes, this file only shapes the input.

import { type AuditFieldDiff, diffRows, REDACTED } from './audit';
import type { CrudCtx } from './crud';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';

const redactedFields = (resource: AdminResource): readonly string[] =>
  resource.fields.filter((field) => field.sensitive).map((field) => field.name);

export interface SplitInput {
  /** What the entity's `$schema` judges — it omits sealed columns, so they must not reach it. */
  readonly open: Readonly<Record<string, unknown>>;
  /** Sealed values the caller actually supplied. Empty is "unchanged", never "set to empty". */
  readonly secrets: Readonly<Record<string, unknown>>;
}

/**
 * A sealed column is WRITE-ONLY here: it rides around `$schema` (which has no member for it) and
 * straight into the repo, whose own parse judges the plaintext before sealing it. An absent or
 * empty value is dropped, so an edit form that left the box empty changes nothing.
 */
export function splitSecrets(
  resource: AdminResource,
  input: Readonly<Record<string, unknown>>,
): SplitInput {
  const names = new Set(resource.secretFields.map((field) => field.name));
  const open: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!names.has(key)) open[key] = value;
    else if (value !== undefined && value !== null && value !== '') secrets[key] = value;
  }
  return { open, secrets };
}

/**
 * The tenant column is never a caller's to choose. A create is stamped with the ACTING actor's
 * tenant — the handle refuses any other, and refuses a row that names none — and a patch never
 * carries the column at all, so a posted `orgId` cannot move a row between tenants or even ask to.
 */
export function withoutTenant(
  resource: AdminResource,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const tenant = resource.entity.$tenantColumn ?? null;
  if (tenant === null || !Object.hasOwn(input, tenant)) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== tenant));
}

export function withTenant(
  resource: AdminResource,
  ctx: CrudCtx,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const tenant = resource.entity.$tenantColumn ?? null;
  const open = withoutTenant(resource, input);
  // An actor with no tenant leaves the column unset, and the entity's own schema refuses the row
  // by the column's name — the admin does not invent a tenant for anyone.
  return tenant === null || ctx.actor.orgId === undefined
    ? open
    : { ...open, [tenant]: ctx.actor.orgId };
}

/**
 * A field declared `on: 'create'` is set once and never patched; one declared `on: 'update'` has no
 * value until the row exists. The form does not draw either on the other side, and this is the
 * same rule for every caller that is not the form — an MCP call, a direct `adminUpdate`.
 */
export function onlyFor(
  resource: AdminResource,
  side: 'create' | 'update',
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const other = new Set(
    [...resource.fields, ...resource.secretFields]
      .filter((field) => field.on !== undefined && field.on !== side)
      .map((field) => field.name),
  );
  if (other.size === 0) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => !other.has(key)));
}

/**
 * The audit diff of one write. A sealed column gets one entry per WRITE — that it changed, never
 * what it held — and never an entry read off a row: a repository row hides the property, but a
 * hand-written `repo:` override may not, and the diff must not be where a plaintext leaks.
 */
export function rowDiff(
  resource: AdminResource,
  before: AdminRow | null,
  after: AdminRow | null,
  secrets: Readonly<Record<string, unknown>> = {},
): readonly AuditFieldDiff[] {
  const sealed = new Set(resource.secretFields.map((field) => field.name));
  return [
    ...diffRows(before, after, { redact: redactedFields(resource) }).filter(
      (change) => !sealed.has(change.field),
    ),
    ...Object.keys(secrets).map((field) => ({ field, before: REDACTED, after: REDACTED })),
  ];
}
