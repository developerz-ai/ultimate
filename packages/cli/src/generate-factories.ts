// Which `x g` generator scaffolds each primitive factory, or why none does. One row per
// `PRIMITIVE_FACTORIES` entry, held to it by `generate-factories.test.ts`: a factory that ships
// with neither a generator nor a reason is refused there, never noticed later.

import type { Generator } from './generate-kinds';

/** A factory `x g <generator>` scaffolds: the one call, its tests, in the feature's slice. */
interface Generated {
  readonly factory: string;
  readonly generator: Generator;
}

/** A factory no generator writes, and the sentence that says why — the decision, on the record. */
interface NotGenerated {
  readonly factory: string;
  readonly none: string;
}

export type FactoryGenerator = Generated | NotGenerated;

/** The model rule three AI factories share: the app registers every model, the framework none. */
const MODEL =
  'calls a model the app registers itself (registerModel, @ultimat3/ai) — the framework registers none, so a generated declaration would name an id that is X_AI_MODEL_UNKNOWN at its first call';

/** Sorted by factory name, as `PRIMITIVE_FACTORIES` is by package then name. */
export const FACTORY_GENERATORS: readonly FactoryGenerator[] = [
  { factory: 'agent', none: MODEL },
  {
    factory: 'agentJob',
    none: 'wraps an action the app already declares, and which one is a choice x g cannot read off the disk; deferred (plan 101 U6) until x g takes the action to wrap',
  },
  { factory: 'backfill', generator: 'backfill' },
  {
    factory: 'consumer',
    none: 'subscribes to an event topic the app publishes — the topic and its payload are the app’s own vocabulary, and a generated consumer would subscribe to nothing',
  },
  { factory: 'cronJob', generator: 'cron-job' },
  {
    factory: 'deviceSocket',
    none: 'a websocket mount speaking the app’s own device protocol; the protocol is the whole of the declaration, and only the app knows it',
  },
  {
    factory: 'exportRows',
    none: 'reads one table through the app’s typed handle into a storage disk; deferred (plan 101 U6) until x g can refuse a slice whose table is not the scaffolded one under its own code',
  },
  { factory: 'hive', none: MODEL },
  {
    factory: 'importRows',
    none: 'writes an uploaded file into one table through the app’s typed handle; deferred (plan 101 U6) on the same refusal exportRows waits for',
  },
  {
    factory: 'ledger',
    none: 'the attempt table a webhook() delivery writes, declared once beside that webhook — it has no meaning without one, so it ships with it',
  },
  { factory: 'llm', none: MODEL },
  {
    factory: 'mcpConfirmations',
    none: 'the MCP server’s own confirmation actions: an app lists the value @ultimat3/mcp returns in defineApi, and has no body of its own to write',
  },
  {
    factory: 'notifier',
    none: 'fans a notification out over the channels the app configures — mail, push, in-app — and which channels exist is the app’s configuration, not a template',
  },
  {
    factory: 'partitions',
    none: 'keeps a partitioned table’s partitions ahead of time, and only a table the schema declares partitioned has any; x db gen writes that declaration',
  },
  {
    factory: 'pdf',
    none: 'renders a page the app serves into a document; the page and its route are the declaration, and x g route writes the route',
  },
  { factory: 'purge', generator: 'purge' },
  {
    factory: 'pushRegister',
    none: 'a framework action over the device registrations @ultimat3/notify stores; an app lists it in defineApi and writes no body',
  },
  {
    factory: 'pushSubscribe',
    none: 'a framework action over the Web Push subscriptions @ultimat3/pwa stores; an app lists it in defineApi and writes no body',
  },
  {
    factory: 'pushUnregister',
    none: 'the other half of pushRegister: a framework action an app lists in defineApi, with no body of its own',
  },
  {
    factory: 'pushUnsubscribe',
    none: 'the other half of pushSubscribe: a framework action an app lists in defineApi, with no body of its own',
  },
  {
    factory: 'refreshView',
    none: 'refreshes a materialized view the schema declares; with no view there is nothing to refresh, and the view is a migration, not a template',
  },
  {
    factory: 'reindex',
    none: 'rebuilds an index the schema declares, concurrently; which index bloats is a measurement on a live database, never a scaffold',
  },
  {
    factory: 'rollup',
    none: 'counts a source table into a destination entity by bucket; deferred (plan 101 U6) until x g plants the destination entity and its migration beside it',
  },
  {
    factory: 'scrape',
    none: 'fetches pages the app names and extracts what the app wants from them; the target and the extraction are the whole declaration',
  },
  {
    factory: 'subjectErase',
    none: 'erases one data subject across every table that holds one, which the app declares per entity — the coverage x verify holds is that declaration',
  },
  {
    factory: 'subjectExport',
    none: 'exports one data subject across the same declared tables subjectErase reads; one declaration per app, written beside the entities',
  },
  {
    factory: 'transition',
    none: 'declares the edges of an entity’s own status column — which states exist is the app’s business convention; x g mutator writes the mutator shape it returns',
  },
  {
    factory: 'uploadFlow',
    none: 'a request and a confirm action over the app’s storage bucket and the row an upload attaches to — both the app’s, and neither on the disk x g reads',
  },
  {
    factory: 'webhook',
    none: 'one signed delivery to an endpoint the app stores, with its ledger; deferred (plan 101 U6) until x g plants the endpoint table and the ledger it needs',
  },
  { factory: 'webhookReceiver', generator: 'webhook-receiver' },
];

/** `x g llm` or `x g agent-job`: the factory a word names, when it is one no generator writes. */
export function factoryWithoutGenerator(raw: string): NotGenerated | undefined {
  const camel = raw.replaceAll(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const row = FACTORY_GENERATORS.find((entry) => entry.factory === camel);
  return row !== undefined && 'none' in row ? row : undefined;
}
