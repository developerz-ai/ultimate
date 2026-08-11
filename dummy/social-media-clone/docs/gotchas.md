# Gotchas

Symptom → cause → fix. Read this when something is already broken; the rules that bite *before* a
symptom live in `CLAUDE.md` instead.

Each entry earns its place by having cost someone real time. Delete one when the guard that
replaces it ships.

---

## `Cannot find module '@ultimat3/action'` and every route 404s

**Symptom.** `x dev` boots, prints "ready", and every URL returns `X_ROUTE_NOT_FOUND` — including
ones you can see on disk. Buried in the log: `ResolveMessage: Cannot find module '@ultimat3/…'`.

**Cause.** Registration *is* the module scan: the framework imports every file under the app's
surface directories to fill its registries. One unresolvable import kills the scan, so the routes
after it never register. A 404 is the second-order symptom; the resolve error is the real one.

**Fix.** `bun install` from the repo root, and check the app is matched by a `workspaces` glob in
the root `package.json`. Confirm with `ls node_modules/@ultimat3/` — the entries must be symlinks
into `packages/`.

**Read the whole boot log, not the last line.** The failure is reported once, at boot, and then
never again.

---

## `Failed to start server. Is port 3000 in use?` — after passing `--port`

**Symptom.** `x dev --port 3879` fails claiming a port is taken, and the port it names is not the
one you passed.

**Cause.** `--port` moves the HTTP listener only. The metrics endpoint always binds
`METRICS_PORT`, default **9090**, so a second `x dev` on a different port still collides on 9090.
The sync role likewise takes `PORT + 1`.

**Fix.** `METRICS_PORT=9391 x dev --port 3879`. Kill strays with `pkill -f "bin.ts dev"`.

---

## A page renders `<div id="x-root"></div>` and nothing else

**Symptom.** `curl` returns a complete, correct `<head>` — title, description, OG tags, canonical —
wrapped around an empty body. No markup, no CSS, no JS.

**Cause.** The client build graph. Check whether the route's component tree is reaching the
response at all before you go looking at your own component: this was a framework-level gap, not an
app bug, and the symptom is identical either way.

**Fix.** Confirm with a route you did not write — the scaffolded landing page. If that is empty
too, it is not your code.

---

## `X_ROUTE_DUPLICATE: / is claimed by both …`

**Symptom.** `x routes` reports a duplicate and drops routes; pages that exist on disk 404.

**Cause.** The route table is keyed by URL, and **the directory is the URL** — `apps/web/site/` and
`apps/admin/app/` both bottom out at `/`. The filename never contributes.

**Fix.** Give one of them a path segment. Run `x routes --json` after any move; it lists every
finding at once rather than stopping at the first.

---

## `X_ROUTE_MODE_INVALID: declares render: 'stream' but has no <Suspense> boundary`

**Symptom.** A route fails the gate for lacking a Suspense boundary, and adding one does not help.

**Cause.** `stream` requires at least one hole to stream into, and the framework has no hole
marker yet. Solid's `<Suspense>` is not one and cannot become one: it calls `getContextId()`,
which throws `cannot be used under non-hydrating context` outside a Solid renderer, and the server
JSX factory is inert by design. So the suggested fix cannot be applied as written — at any Solid
version. This is not the old `2.0.0-experimental` pin; repinning to `1.9.14` did not change it.

**Fix.** Use `render: 'ssr'`. Async data needs no boundary at all — `renderToHtml` awaits async
components and promise children, so `await` the data in the component. Reach for `stream` once the
framework ships its own hole marker.

---

## A test passes alone and fails in the suite

**Cause.** Shared fixture contention — one database, one port, one directory, several workers.
Failures wander and name tables the test never wrote.

**Fix.** Read a wandering failure as contention *before* believing what it says. Each worker gets
its own cloned database; never hand-write a `DATABASE_URL` to work around it — that is a harness
bug, and hiding it makes the next one harder to see.
