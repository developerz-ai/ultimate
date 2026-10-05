// `measureMcpSurface` / `assertMcpSurfaceBudget`: the characters an agent reads, off the wire, per
// caller — and a refusal naming every surface over its ceiling.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller } from './registry';
import { jsonResult } from './registry';
import { createMcpServer } from './server';
import { assertMcpSurfaceBudget, measureMcpSurface } from './surface-budget';
import type { JsonSchema } from './wire';
import { NO_ARGS } from './wire';

const tool = (name: string): AnyMcpTool => ({
  name,
  description: `The ${name} tool, described at some length so the catalog has weight.`,
  inputSchema: NO_ARGS,
  destructive: false,
  handle: async () => jsonResult({ ok: true }),
});

const staff: McpCaller = {
  actor: agentActor({ id: 's', orgId: 'o', roles: ['staff'] }),
  role: 'staff',
  scopes: new Set<string>(),
};
const customer: McpCaller = { ...staff, role: 'customer' };

const server = () =>
  createMcpServer({
    tools: [tool('a'), tool('b'), tool('docs')],
    surface: (caller) => (caller.role === 'staff' ? 'meta' : 'flat'),
    groups: { things: { description: 'Things', tools: ['a', 'b'] } },
    instructions: (caller) => (caller.role === 'staff' ? 'Staff advice.' : undefined),
  });

describe('assertMcpSurfaceBudget', () => {
  test('names every surface over its ceiling in one refusal', async () => {
    const refused = await assertMcpSurfaceBudget(server(), staff, {
      toolsList: 10,
      listResources: 10,
      instructions: 1_000,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: 'X_MCP_SURFACE_OVER_BUDGET' });
    const cause = (refused as { cause: string }).cause;
    expect(cause).toInclude('tools/list is ');
    expect(cause).toInclude('list_resources is ');
    expect(cause).not.toInclude('instructions');
  });

  test('within budget answers the measurement', async () => {
    const size = await assertMcpSurfaceBudget(server(), staff, { toolsList: 100_000 });
    expect(size.toolsList).toBeGreaterThan(0);
  });
});

describe('measureMcpSurface', () => {
  test('measures per caller: the meta population reads list_resources, the flat one has none', async () => {
    const meta = await measureMcpSurface(server(), staff);
    const flat = await measureMcpSurface(server(), customer);
    expect(meta.listResources).toBeGreaterThan(0);
    expect(meta.instructions).toBe('Staff advice.'.length);
    expect(flat.listResources).toBeUndefined();
    expect(flat.instructions).toBe(0);
  });

  test('tools/list is measured as serialized — the bytes a client hands its model', async () => {
    const s = server();
    const response = await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, customer);
    const size = await measureMcpSurface(s, customer);
    expect(size.toolsList).toBe(JSON.stringify(response?.result).length);
  });
});

// A catalog at the scale #590 measured (Notificado: 65 actions in 14 resources, 15,173 characters
// of `list_resources` at 22.13 against a 12k budget). Not a copy of that app: names, descriptions
// of real length, 1–10 params with enums, writes that confirm, and BOTH scope shapes — a resource
// one token scope covers (`one`) and one split into `:read`/`:write` (`split`) — so every rendering
// rule is exercised and none is tuned to one app's shape. A resource line, then its actions
// indented: `name | r(ead)/w(rite)/c(onfirmed write) | description | params`; `!` marks required.
const CATALOG = `
cases | one | Court cases (procesos) the account follows, by radicado, with their latest actuación.
  listCases | r | List the cases of the account, newest court activity first; filters combine with AND. | status_eq:active|archived|closed court_eq:string client_eq:string lawyer_eq:string updated_gte:string updated_lte:string q:string sort:radicado|-radicado|updatedAt|-updatedAt cursor:string limit:integer
  getCase | r | One case with its parties, court, assigned lawyer and the last ten actuaciones. | radicado!:string
  followCase | w | Start following a case by its 23-digit radicado; the court is resolved from the number. | radicado!:string clientId:string lawyerId:string note:string
  archiveCase | c | Archive a case: polling stops and its client stops receiving notifications about it. | radicado!:string reason!:string
  reassignCase | w | Move a case to another lawyer of the account; both lawyers are told by email. | radicado!:string userId!:string note:string
  searchCases | r | Full-text search across case parties, notes and actuación text, best match first. | q!:string court_eq:string cursor:string limit:integer
parties | one | People and companies that appear as parties (demandante, demandado, terceros) in followed cases.
  listParties | r | Parties of the account, filtered by name or document number, alphabetical by name. | name_cont:string document_eq:string documentType_eq:CC|NIT|CE|PP role_eq:plaintiff|defendant|third cursor:string limit:integer
  getParty | r | One party with its contact details and every followed case it appears in. | id!:string
  mergeParties | c | Merge two duplicate parties into one; every case of the second moves to the first. | keepId!:string dropId!:string
  updateParty | w | Correct the name, document or contact details of a party across all of its cases. | id!:string name:string document:string documentType:CC|NIT|CE|PP email:string phone:string
notifications | split | Notifications sent to clients when one of their cases moves, on their preferred channel.
  listNotifications | r | Notifications sent or queued, newest first, with their delivery status per channel. | status_eq:queued|sent|failed|bounced channel_eq:email|sms|whatsapp radicado_eq:string client_eq:string sent_gte:string sent_lte:string cursor:string limit:integer
  getNotification | r | One notification with its rendered body, recipient and every delivery attempt made. | id!:string
  resendNotification | w | Queue a failed or bounced notification again, optionally on a different channel. | id!:string channel:email|sms|whatsapp
  sendNotification | c | Send a one-off notification about a case to its client now, outside the schedule. | radicado!:string templateId!:string channel!:email|sms|whatsapp note:string
  cancelNotification | w | Cancel a queued notification before it is sent; a sent one cannot be recalled. | id!:string reason:string
documents | one | Files attached to cases: filings (memoriales), rulings (autos, sentencias) and client uploads.
  listDocuments | r | Documents of one case, newest first, without their contents. | radicado!:string kind_eq:filing|ruling|upload|other uploaded_gte:string cursor:string limit:integer
  getDocument | r | One document with its metadata and a download URL that expires in five minutes. | id!:string
  uploadDocument | w | Attach a document to a case from an upload token obtained from the upload endpoint. | radicado!:string uploadToken!:string kind!:filing|ruling|upload|other title:string
  deleteDocument | c | Delete a document from a case permanently, including every stored copy of the file. | id!:string reason!:string
  renameDocument | w | Change the title of a document as it appears in the case and in client notifications. | id!:string title!:string
deadlines | one | Procedural deadlines (términos) computed from actuaciones on business days of the court.
  listDeadlines | r | Deadlines due in a window, soonest first, with the lawyer responsible for each. | due_gte:string due_lte:string status_eq:open|met|missed lawyer_eq:string radicado_eq:string cursor:string limit:integer
  getDeadline | r | One deadline, the actuación it comes from and the business-day computation behind it. | id!:string
  markDeadlineMet | w | Record that a deadline was met, with the filing document that met it. | id!:string documentId:string note:string
  addDeadline | w | Add a manual deadline to a case, with a reminder some days before it is due. | radicado!:string dueOn!:string title!:string remindDaysBefore:integer
  removeDeadline | c | Remove a manual deadline; deadlines computed from actuaciones cannot be removed. | id!:string
hearings | one | Scheduled hearings (audiencias) of followed cases, in person or virtual.
  listHearings | r | Hearings in a window, soonest first, with their mode and the lawyer attending. | starts_gte:string starts_lte:string radicado_eq:string lawyer_eq:string mode_eq:in_person|virtual|hybrid cursor:string limit:integer
  getHearing | r | One hearing with its court room, virtual link and the parties summoned. | id!:string
  scheduleHearing | w | Record a hearing the court announced; the client is notified on their channel. | radicado!:string startsAt!:string mode!:in_person|virtual|hybrid link:string room:string
  rescheduleHearing | w | Move a hearing to the new time the court set; the client is notified again. | id!:string startsAt!:string note:string
  cancelHearing | w | Record that the court cancelled a hearing; the client is told it will not happen. | id!:string reason:string
courts | one | Courts (despachos judiciales) the account polls for new actuaciones, and their polling health.
  listCourts | r | Courts the account polls, with the last successful poll and its error rate. | city_eq:string health_eq:ok|degraded|down specialty_eq:civil|labor|family|admin cursor:string limit:integer
  getCourt | r | One court with its polling history for the last seven days. | id!:string
  pollCourtNow | w | Poll one court immediately instead of waiting for the next scheduled run. | id!:string
  pauseCourtPolling | c | Stop polling a court until resumed; none of its cases update while paused. | id!:string reason!:string
clients | one | Clients of the account, their cases, and how each one wants to be notified.
  listClients | r | Clients, filtered by name or document number, alphabetical by name. | name_cont:string document_eq:string channel_eq:email|sms|whatsapp created_gte:string cursor:string limit:integer
  getClient | r | One client with their followed cases and notification preferences. | id!:string
  createClient | w | Create a client with a document number and a preferred notification channel. | name!:string document!:string documentType:CC|NIT|CE|PP email:string phone:string channel:email|sms|whatsapp
  updateClient | w | Update the contact details and notification preferences of a client. | id!:string name:string email:string phone:string channel:email|sms|whatsapp
  deleteClient | c | Delete a client who has no followed cases left; their history is kept for audit. | id!:string
invoices | split | Invoices issued to clients for legal services on followed cases, in COP.
  listInvoices | r | Invoices, newest first, with their status and outstanding balance. | status_eq:draft|issued|paid|void client_eq:string issued_gte:string issued_lte:string cursor:string limit:integer
  getInvoice | r | One invoice with its lines, the payments recorded against it and the balance. | id!:string
  issueInvoice | c | Issue a draft invoice to its client by email; it can no longer be edited after. | id!:string
  voidInvoice | c | Void an issued invoice; the client is told and the balance is cancelled. | id!:string reason!:string
  recordPayment | w | Record a payment received against an issued invoice, in minor units. | id!:string amountMinor!:integer currency!:string paidOn!:string reference:string
users | split | Lawyers and assistants of the account, and the role each one holds.
  listUsers | r | Users of the account with their roles and the number of cases assigned to each. | role_eq:owner|lawyer|assistant active_eq:boolean cursor:string limit:integer
  getUser | r | One user with their assigned cases and upcoming deadlines. | id!:string
  inviteUser | c | Invite a user by email with a role; the invitation expires in seven days. | email!:string role!:owner|lawyer|assistant
  changeUserRole | c | Change the role of a user; an account always keeps at least one owner. | id!:string role!:owner|lawyer|assistant
  deactivateUser | c | Deactivate a user; every case assigned to them must be reassigned first. | id!:string
templates | one | Message templates the client notifications are rendered from, one per channel and event.
  listTemplates | r | Templates of the account by channel and event, with the variables each one uses. | channel_eq:email|sms|whatsapp event_eq:actuacion|hearing|deadline cursor:string limit:integer
  getTemplate | r | One template with its body, its variables and a sample render. | id!:string
  createTemplate | w | Create a template for a channel and an event. | name!:string channel!:email|sms|whatsapp event!:actuacion|hearing|deadline subject:string body!:string
  updateTemplate | w | Edit the subject or body of a template; queued notifications keep the old text. | id!:string subject:string body!:string
  previewTemplate | r | Render a template against a real case without sending anything. | id!:string radicado!:string
reports | one | Activity and delivery reports for the account over a date window.
  caseActivityReport | r | Actuaciones per case in a window, most active first. | from!:string to!:string lawyerId:string court:string
  deliveryReport | r | Notification delivery and bounce rates per channel in a window. | from!:string to!:string channel:email|sms|whatsapp
  deadlineReport | r | Deadlines met and missed per lawyer in a window. | from!:string to!:string
  exportReport | w | Export a report as CSV and email a download link to the caller. | report!:activity|delivery|deadlines from!:string to!:string
webhooks | split | Outbound webhooks that deliver case events to the account’s own systems.
  listWebhooks | r | Webhook endpoints with the events each receives and its last delivery status. | active_eq:boolean cursor:string limit:integer
  createWebhook | w | Register a webhook endpoint for a set of events; deliveries are signed with its secret. | url!:string events!:string[] secret:string
  deleteWebhook | c | Delete a webhook endpoint; queued deliveries to it are dropped. | id!:string
  replayWebhook | w | Replay one failed delivery to its endpoint with its original payload. | deliveryId!:string
audit | one | The audit trail of the account: who did what, when, through which surface.
  listAuditEvents | r | Audit events, newest first. | actor_eq:string action_eq:string surface_eq:http|mcp|job at_gte:string at_lte:string cursor:string limit:integer
  getAuditEvent | r | One audit event with its full payload and the request it came from. | id!:string
  exportAuditLog | w | Export the audit trail of a window as CSV, emailed to the caller. | from!:string to!:string actorId:string
`;

interface FixtureResource {
  readonly name: string;
  readonly scopes: string;
  readonly description: string;
  readonly tools: AnyMcpTool[];
}

const catalog: readonly FixtureResource[] = CATALOG.trim()
  .split('\n')
  .reduce<FixtureResource[]>((resources, line) => {
    const cells = line.trim().split(' | ');
    const [name = '', second = '', description = '', params = ''] = cells;
    if (!line.startsWith('  ')) {
      resources.push({ name, scopes: second, description: cells[2] ?? '', tools: [] });
      return resources;
    }
    const resource = resources.at(-1);
    resource?.tools.push({
      name,
      description,
      inputSchema: schemaFromRow(params),
      destructive: second !== 'r',
      ...(second === 'c' ? { confirms: true } : {}),
      scope:
        resource.scopes === 'one'
          ? resource.name
          : `${resource.name}:${second === 'r' ? 'read' : 'write'}`,
      handle: async () => jsonResult({ ok: true }),
    });
    return resources;
  }, []);

/** `name!:a|b` → a JSON-Schema property; `string[]` an array of strings. */
function schemaFromRow(params: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of params.split(' ').filter(Boolean)) {
    const [head = '', type = 'string'] = field.split(':');
    const name = head.replace('!', '');
    if (head.endsWith('!')) required.push(name);
    properties[name] = type.includes('|')
      ? { type: 'string', enum: type.split('|') }
      : type === 'string[]'
        ? { type: 'array', items: { type: 'string' } }
        : { type: type as 'string' | 'integer' | 'boolean' };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

const catalogTools = catalog.flatMap((resource) => resource.tools);

describe('a 65-action catalog', () => {
  const big = () =>
    createMcpServer({
      tools: catalogTools,
      surface: 'meta',
      groups: Object.fromEntries(
        catalog.map((r) => [
          r.name,
          { description: r.description, tools: r.tools.map((t) => t.name) },
        ]),
      ),
    });
  const everyScope: McpCaller = {
    ...staff,
    scopes: new Set(catalogTools.flatMap((t) => (t.scope === undefined ? [] : [t.scope]))),
  };

  test('is the scale #590 measured', () => {
    expect(catalogTools.length).toBe(65);
    expect(catalog.length).toBe(14);
  });

  // Measured: 13,361 characters before #590 (per-action `(kind; scope …)` tags, a 240-character
  // hint cut mid-field); 11,585 after (scopes hoisted, `query` untagged, hints cut by field).
  test('list_resources fits the 12k budget a staff surface is held to', async () => {
    const size = await assertMcpSurfaceBudget(big(), everyScope, { listResources: 12_000 });
    expect(size.listResources).toBeGreaterThan(0);
  });
});
