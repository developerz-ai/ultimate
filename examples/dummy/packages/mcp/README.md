# @postly/mcp

Postly's own MCP server. Not the framework's dev server — this is the one the *user's* agents
connect to, authenticated as a Postly member and gated by Postly's policies.

```
ws://localhost:3000/_mcp
```

## Where the tools come from

| Source | Count | Rule |
|---|---|---|
| Actions + the mutator with `mcp: { expose: true }` | 7 | generated — name, JSON Schema, description and **policy** all come from the declaration |
| Queries with `mcp: { expose: true }` | 3 | read-only, same policies, same row filters |
| `llm` calls with `mcp: { expose: true }` | 1 | `summarize`, with its prompt version and cost budget attached |
| Tools declared here | 3 | app-specific reads that are not actions: a digest preview, a seat report, a plan quote |

14 tools total; `x mcp ls --json` prints the current list, and `x.manifest.json` records it per build.

Adding a feature adds a capability. Deleting one removes it. Nobody maintains a tool list.

## The authz property

An MCP call and an HTTP call reach the **same** `policy` object with the same actor resolution:

```
agent → tool postly.publishPost → policy post:publish → ownsPost(actor, postId)
human → POST /api/posts/publish → policy post:publish → ownsPost(actor, postId)
```

There is no MCP-specific permission table, no trusted-tool mode, and no service account with
broad rights. An agent can never exceed the human it acts for. Two authz systems is how every
Meteor-shaped framework died; the same rule applies to a tool surface.

## Tools declared here

| Tool | Policy | Why it is not an action |
|---|---|---|
| `postly.digestPreview` | `member:self` | renders what tonight's digest would say for the acting member — a read with no side effect |
| `postly.seatReport` | `org:administer` | seats used, seats left, and what the next plan costs — three reads an agent otherwise stitches together |
| `postly.planQuote` | `org:administer` | a prorated upgrade quote **without** charging; `upgradePlan` is the one that spends money |

`planQuote` exists precisely so an agent can answer "what would this cost?" without the tool that
takes money being the only way to find out.

## Prompts and evals

The summarisation prompt lives with its feature
(`apps/web/app/posts/prompts/summarize.v3.md`) and is exposed here as an MCP prompt resource.
Editing it requires a version bump, and a prompt without an evals file fails `x verify`.

## Rules

- Never declare a tool that duplicates an action. Expose the action.
- Never widen a policy for a tool. If an agent needs more, the human needs more first.
- Every tool description is a sentence an agent can act on: what it does and what it costs.
- Read tools are free to call; anything that spends money or sends mail is an action, so it is
  audited by the same span and log line as an HTTP call.
