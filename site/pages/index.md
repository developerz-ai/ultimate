---
title: Ultimate
menu: true
nav: Home
headline: Rails' philosophy for a stack whose primary user is an AI agent.
lede: One way to do each thing. Eight primitives. One authz system across HTTP, WebSockets, jobs and MCP. Bun, Postgres and SolidJS, with the boring 40% of every app already in the box.
description: Ultimate is a Bun-only, agent-first full-stack framework — eight primitives, one authz system, and a 0kb JS baseline on the static path.
updated: 2026-07-26
---

```bash
$ bunx create-ultimate myapp && cd myapp && x dev
  ✓ database   embedded postgres, migrated, seeded
  ✓ site       static, 0kb js, sitemap + feeds
  ✓ app        stream, realtime wired
  ✓ admin      mcp exposed
  ✓ mcp        ws://localhost:9229
  ✓ ready      http://localhost:3000
```

<section class="band" id="thesis">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">Why</span>

## Agents fail on ambiguity, not on syntax

Every "you could use A or B here" is a branch point where an agent guesses, ships, and the
guess is discovered in production. Ambiguity is the tax agents pay — Ultimate's job is to not
levy it. A framework optimised for agents turns out to be the calmest one for humans: both
audiences want fewer decisions with consequences.

</div>

| Audience | What they need | What that forces |
|---|---|---|
| **Primary: an AI agent** | one correct way, machine-readable errors, generated facts to read | no choice menus, `--json` everywhere, `x.manifest.json` emitted from code |
| **Secondary: a tired senior engineer** | no glue code, no 3am pager, no config archaeology | batteries in-box, typed env at boot, `x verify` as the only gate |

</div>
</section>

<section class="band band--soft" id="artifacts">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">Define once, project everywhere</span>

## One `action`, six artifacts

Write the mutation. The framework projects it into every surface it belongs in — with the same
policy, the same actor resolution, the same denial error in all of them.

</div>

```ts title="apps/web/api/posts/actions.ts"
// action
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });
    return post;
  },
});
```

| # | Generated | Derived from | Notes |
|---|---|---|---|
| 1 | **HTTP route** | name + `input` | `POST /_x/action/publish-post`, body parsed by `input`, errors are `UltimateError` JSON |
| 2 | **OpenAPI operation** | `input` + `output` + `mcp.description` | emitted into `x.manifest.json` and `openapi.json`; contract diff runs in `x verify` |
| 3 | **Typed client function** | `input` + `output` | `await publishPost({ postId })` in `app/` — no fetch, no codegen step to remember |
| 4 | **Job handle** | the whole declaration | `ctx.jobs.enqueue(publishPost, input)` runs the same handler durably |
| 5 | **MCP tool** | `mcp` + `input` + `policy` | one tool per exposed action, JSON Schema from `input`, authz unchanged |
| 6 | **Test scaffold** | `input` + `policy` | a contract test asserting schema round-trip and a denial per policy branch |

:::warn one authz system
`policy` is evaluated for the HTTP call, the typed client call, the job execution, the MCP tool
call and the live-query subscription. Two authz systems is how every Meteor-like framework
died — so a "public" MCP tool, an "internal" RPC, or a sync rule table is a rejected design,
not a config option.
:::

</div>
</section>

<section class="band" id="primitives">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">The vocabulary</span>

## Eight primitives, and nothing else

If a feature doesn't fit a primitive, it doesn't ship.

</div>

<div class="grid">
<article class="primitive"><span class="primitive__name">entity</span><p>A table + its domain type + invariants. Projects to a Drizzle table, a migration, a repo type, an admin screen and a seed factory.</p></article>
<article class="primitive"><span class="primitive__name">policy</span><p>An authz rule, evaluated in every surface — HTTP guard, live-query row filter, job actor check, MCP tool gate, admin visibility.</p></article>
<article class="primitive"><span class="primitive__name">action</span><p>A mutation or command, server-authoritative. Six generated artifacts, one declaration.</p></article>
<article class="primitive"><span class="primitive__name">mutator</span><p>An action with an optimistic local twin. <code>local</code> runs on the client, <code>server</code> is the truth, <code>conflict</code> decides the rebase.</p></article>
<article class="primitive"><span class="primitive__name">query</span><p>A read; optionally live. <code>live: true</code> needs a deterministic, bounded <code>sql</code> or the build rejects it.</p></article>
<article class="primitive"><span class="primitive__name">job</span><p>Durable background work with steps. <code>idempotencyKey</code> is required by the type, not by a lint rule.</p></article>
<article class="primitive"><span class="primitive__name">route</span><p>A URL + render mode + metadata + offline strategy. Missing <code>meta.description</code> on a <code>site/</code> route is a build error.</p></article>
<article class="primitive"><span class="primitive__name">task</span><p>A cron trigger with an explicit IANA <code>tz</code> that only enqueues jobs. A handler body makes it a job.</p></article>
</div>

<p class="btn-row"><a class="btn btn--ghost" href="/primitives/">Every primitive, with its code</a></p>

</div>
</section>

<section class="band band--soft" id="realtime">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">Realtime</span>

## A ladder, not three products

Same `mutator` shape at every rung. Climbing is a config change, never a rewrite.

</div>

<div class="ladder">
<article class="rung">
<h3>Channels</h3>
<p>You write <code>ctx.channel('org:1').publish(evt)</code>. Server owns truth and fanout; the client owns its subscription. Presence, typing indicators, cursors, toasts.</p>
<p><small>Cost: pubsub over WebSockets.</small></p>
</article>
<article class="rung">
<h3>Live queries</h3>
<p>You write <code>query({ live: true, sql })</code>. The server detects changes through logical replication; the client gets a reactive result set patched per row.</p>
<p><small>Cost: one replication slot and a matcher.</small></p>
</article>
<article class="rung">
<h3>Local-first</h3>
<p>The same <code>mutator</code>, plus <code>persist: true</code> on the query. Durable local store, offline writes, rebase on reconnect per the mutator's <code>conflict</code>.</p>
<p><small>Cost: IndexedDB store + rebase log. Planned for v2.</small></p>
</article>
</div>

Tier 2 covers what people usually mean by "make it realtime": the list updates without a
refresh, and my own click feels instant — with no client database, no client schema
versioning, and no conflict-resolution UX to design. Tier 3 buys exactly one more property,
writes that survive being offline, and charging every app for that is how realtime frameworks
become slow frameworks.

<p class="btn-row"><a class="btn btn--ghost" href="/realtime/">The three tiers in detail</a></p>

</div>
</section>

<section class="band" id="free">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">Batteries</span>

## What you get without deciding anything

The boring 40% of every app, decided once, in the box.

</div>

<div class="grid">
<article class="card"><h3>i18n</h3><p>Flat key catalogs, <code>t()</code> everywhere, loud misses: a missing key renders <code>⟦key⟧</code> in dev and fails <code>x verify</code> in CI. Reciprocal <code>hreflang</code> per route.</p></article>
<article class="card"><h3>Dark theme</h3><p>Semantic tokens as RGB channels, light + dark defined once, an explicit <code>data-theme</code> override beating the OS. A raw hex in a stylesheet fails lint.</p></article>
<article class="card"><h3>Timezones</h3><p>Store UTC, format with <code>Intl.DateTimeFormat</code> and an explicit IANA zone. A date formatted without one is a lint failure, not a bug report from Auckland.</p></article>
<article class="card"><h3>Money</h3><p><code>Money = { minor, currency }</code> — integer minor units and an ISO code, never a float. <code>Intl.NumberFormat</code> at the edge only.</p></article>
<article class="card"><h3>Offline</h3><p><code>sw.js</code> is generated from the route table and never hand-edited. Version skew is handled with build IDs, asset retention and an update signal — not a dinosaur.</p></article>
<article class="card"><h3>Admin</h3><p>A generated admin app that reads the manifest: entity screens, action runners, queue views with step timelines — behind the same policies as the rest.</p></article>
<article class="card"><h3>MCP</h3><p><code>x dev</code> serves an MCP server for routes, schema, policies, tests, logs, read-only SQL and branch migrations. Your app's own actions become your users' agents' tools.</p></article>
<article class="card"><h3>Jobs &amp; cron</h3><p>Postgres queue with a transactional outbox, durable steps, per-tenant concurrency and rate limits, and a scheduler elected by advisory lock.</p></article>
</div>

</div>
</section>

<section class="band band--soft" id="steal">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">Prior art</span>

## Steal explicitly

Nothing here is novel in isolation. The bet is that no one has assembled it in one runtime
with one authz system.

</div>

| Source | What we take | Why |
|---|---|---|
| **Rails** | convention over configuration, generators, one blessed path, batteries included | the only proven cure for decision fatigue at framework scale |
| **Meteor** | realtime as a default, not an add-on | realtime bolted on later never gets the authz story right |
| **Next.js** | per-route render modes, ISR, streaming shells | render mode is a route-level property, never a global one |
| **Laravel** | queues, mail, storage, scheduler in-box + genuinely good error pages | "batteries" means the boring 40% of every app, and errors that teach |
| **Phoenix LiveView** | server-authoritative realtime, channels, presence | the server owns truth; the client owns latency hiding |
| **Zero + Replicache** | optimistic mutators whose code is identical client and server | one function, two executions — the only local-first shape that stays honest |
| **Inngest** | durable step workflows | a step is the retry unit, the job is not |
| **Elixir/OTP** | supervision trees, graceful drain, role-based processes | one image, N roles, restart semantics you can reason about |
| **Django** | admin-grade introspection, migrations that don't lie | if the framework can't describe itself, neither can an agent |

</div>
</section>

<section class="band" id="status">
<div class="wrap">
<div class="band__head">
<span class="eyebrow">Status</span>

## Honest state, As of 2026-07

</div>

<p class="pill-row">
<span class="pill pill--warn">pre-v1</span>
<span class="pill pill--danger">not production-ready</span>
<span class="pill pill--info">nothing published to npm yet</span>
</p>

The plan is 12 milestones, each ending in a working demo app and a green `x verify`.
Milestones 0–5 ship before any realtime work, because a framework that cannot render, migrate,
enqueue and verify has no business synchronising anything. Realtime tiers 1–2 are v1 work;
tier 3 (local-first) is v2. Milestone 6 is a reconnect benchmark — 50k sockets, a forced `sync`
restart, measured time-to-consistent — and the sync topology is **not frozen** until that
number exists. The sync engine is roughly 70% of the total effort and the single largest risk;
if the benchmark says our matcher is the bottleneck, adopting an existing protocol beats
inventing one.

No adoption numbers, no benchmark charts and no testimonials appear anywhere on this site,
because none of them exist yet.

<p class="btn-row"><a class="btn" href="/quickstart/">Read the quickstart</a><a class="btn btn--ghost" href="/roadmap/">See the roadmap</a></p>

</div>
</section>
