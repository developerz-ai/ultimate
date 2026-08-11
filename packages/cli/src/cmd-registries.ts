// `x actions`, `x queries`, `x entities` — the declaration registries as a table or as JSON.
// Replaces grepping a source tree, which is what an agent does when the framework has no answer
// to "what actions/queries/entities exist". One table, one generic command body: the three
// commands differ only in which registry they read, a row's columns, and (for a query only) the
// one extra field `describe` surfaces that its descriptor does not already carry.

import type { ActionDescriptor, AnyAction } from '@ultimat3/action';
import { describeActions, getAction, jsonSchemaOf } from '@ultimat3/action';
import type { EntityDescription, RegistryEntry } from '@ultimat3/entity';
import { describeEntities, getEntity } from '@ultimat3/entity';
import type { AnyQuery, QueryDescriptor } from '@ultimat3/query';
import { describeQueries, getQuery } from '@ultimat3/query';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, DeclarationUnknownError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import type { CommandSpec } from './parse';
import { nearest } from './parse';
import { renderTable } from './table';

/**
 * A descriptor is plain JSON by construction; only its `unknown`-typed schema fields need this
 * cast to satisfy `JsonValue` — same idiom as `@ultimat3/manifest`'s `asJson`.
 */
const asJson = (value: object): Record<string, JsonValue> => value as Record<string, JsonValue>;

const formatValue = (value: JsonValue): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** One `key: value` line per top-level field — generic across all three descriptor shapes. */
const detailLines = (payload: Readonly<Record<string, JsonValue>>): readonly string[] =>
  Object.entries(payload).map(([key, value]) => `  ${key}: ${formatValue(value)}`);

/**
 * One config per registry: how `list` renders a row, and what `describe` adds beyond the
 * descriptor itself — only a query's input schema does (`QUERIES.extra`); `ActionDescriptor`
 * already carries `input`/`output`, and an entity has no invocation shape to surface.
 */
interface RegistryKind<D extends { readonly name: string }, Raw extends { describe(): D }> {
  readonly kind: 'actions' | 'queries' | 'entities';
  readonly singular: string;
  readonly spec: CommandSpec;
  readonly header: readonly string[];
  list(): readonly D[];
  find(name: string): Raw | undefined;
  row(item: D): readonly string[];
  extra(raw: Raw): Readonly<Record<string, JsonValue>>;
}

const ACTIONS: RegistryKind<ActionDescriptor, AnyAction> = {
  kind: 'actions',
  singular: 'action',
  spec: {
    name: 'actions',
    summary: 'the action registry: input/output schema, policy, tags, MCP exposure',
    usage: 'x actions [list|describe <name>] [--json]',
    subcommands: ['list', 'describe'],
    requiresApp: true,
  },
  header: ['name', 'verb', 'resource', 'path', 'capability', 'mcp'],
  list: describeActions,
  find: getAction,
  row: (a) => [a.name, a.verb, a.resource, a.path, a.capability, a.mcp.expose ? 'yes' : 'no'],
  extra: () => ({}),
};

const QUERIES: RegistryKind<QueryDescriptor, AnyQuery> = {
  kind: 'queries',
  singular: 'query',
  spec: {
    name: 'queries',
    summary: 'the query registry: schema, policy, live, cache tags',
    usage: 'x queries [list|describe <name>] [--json]',
    subcommands: ['list', 'describe'],
    requiresApp: true,
  },
  header: ['name', 'live', 'capability', 'tags', 'ttlMs'],
  list: describeQueries,
  find: getQuery,
  row: (q) => [
    q.name,
    q.live ? 'yes' : 'no',
    q.capability,
    q.tags.length === 0 ? '-' : q.tags.join(','),
    q.ttlMs === null ? '-' : String(q.ttlMs),
  ],
  // The descriptor carries no input shape at all; the JSON-schema view of it is cheap and is
  // exactly what an agent needs before it can call `x dev`'s query endpoint correctly.
  extra: (raw) => ({ input: asJson(jsonSchemaOf(raw.input)) }),
};

const ENTITIES: RegistryKind<EntityDescription, RegistryEntry> = {
  kind: 'entities',
  singular: 'entity',
  spec: {
    name: 'entities',
    summary: 'the entity registry: columns, invariants, indexes, tenancy',
    usage: 'x entities [list|describe <name>] [--json]',
    subcommands: ['list', 'describe'],
    requiresApp: true,
  },
  header: ['name', 'table', 'columns', 'invariants', 'indexes', 'orgScoped'],
  list: describeEntities,
  find: getEntity,
  row: (e) => [
    e.name,
    e.table,
    String(e.columns.length),
    String(e.invariants.length),
    String(e.indexes.length),
    e.orgScoped ? 'yes' : 'no',
  ],
  extra: () => ({}),
};

function listResult<D extends { readonly name: string }, Raw extends { describe(): D }>(
  kind: RegistryKind<D, Raw>,
  findings: readonly Finding[],
): CommandResult {
  const items = kind.list();
  return {
    ok: findings.length === 0,
    command: kind.kind,
    summary: msg('cli.registry.count', { count: items.length, kind: kind.kind }),
    lines:
      items.length === 0
        ? []
        : renderTable(kind.header, items.map(kind.row)).map((line) => `  ${line}`),
    findings,
    data: items.map((item) => asJson(item)),
  };
}

function describeResult<D extends { readonly name: string }, Raw extends { describe(): D }>(
  kind: RegistryKind<D, Raw>,
  ctx: CommandContext,
  findings: readonly Finding[],
): CommandResult {
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    throw new BadFlagError({
      flag: 'name',
      command: kind.kind,
      reason: `x ${kind.kind} describe <name> needs a name`,
      fix: `x ${kind.kind} list --json`,
    });
  }
  const raw = kind.find(name);
  if (raw === undefined) {
    const known = kind.list().map((item) => item.name);
    const suggestion = nearest(name, known);
    throw new DeclarationUnknownError(
      suggestion === undefined
        ? { kind: kind.kind, singular: kind.singular, name, known }
        : { kind: kind.kind, singular: kind.singular, name, known, suggestion },
    );
  }
  const payload: Record<string, JsonValue> = { ...asJson(raw.describe()), ...kind.extra(raw) };
  return {
    ok: findings.length === 0,
    command: kind.kind,
    summary: msg('cli.registry.described', { kind: kind.singular, name }),
    lines: detailLines(payload),
    findings,
    data: payload,
  };
}

async function runRegistryCommand<
  D extends { readonly name: string },
  Raw extends { describe(): D },
>(kind: RegistryKind<D, Raw>, ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot(kind.kind, ctx.cwd).dir;
  const { findings } = await loadApp(root);
  return ctx.args.subcommand === 'describe'
    ? describeResult(kind, ctx, findings)
    : listResult(kind, findings);
}

export const actionsCommand: CliCommand = {
  spec: ACTIONS.spec,
  run: (ctx) => runRegistryCommand(ACTIONS, ctx),
};

export const queriesCommand: CliCommand = {
  spec: QUERIES.spec,
  run: (ctx) => runRegistryCommand(QUERIES, ctx),
};

export const entitiesCommand: CliCommand = {
  spec: ENTITIES.spec,
  run: (ctx) => runRegistryCommand(ENTITIES, ctx),
};
