# @postly/admin

The admin dashboard, in one file. `src/index.ts` is the whole app.

```bash
x dev --app admin     # http://localhost:3002/admin
```

## What the 20 lines buy

| Declared | Generated |
|---|---|
| `entities` | list, detail, create and edit screens with the entity's own invariants as validation |
| `tenant: 'orgId'` | every screen scoped to the acting org — the dashboard has no cross-tenant mode |
| `actions` | a button per action, running the *same* action with the *same* policy |
| `policies` | visibility and edit rights; a denied action is not rendered and would be refused anyway |
| `search` | indexed search over the named columns |
| `mcp: { expose: true }` | an MCP server over the same actions, authenticated as the signed-in admin |

## Why it ships with MCP on

An admin dashboard is where operations happen: republish a post, move an org to a plan, fix a
membership. Those are exactly the tasks people want an agent to do. Because the tools are the
app's own actions, the agent inherits the human's permissions — it can never exceed the person
it acts for, and there is no separate "API permissions" screen to get wrong.

```
ws://localhost:3002/admin/_mcp
  postly.publishPost     policy post:publish
  postly.inviteMember    policy org:invite
  postly.upgradePlan     policy org:administer
```

## Rules

- No business logic here. If admin needs a rule, it belongs in `@postly/core` where the web app
  and the worker can use it too.
- No admin-only policy. A rule that exists only for admin is a second authz system.
- Adding an entity to `entities` is the entire change needed to administer it.
