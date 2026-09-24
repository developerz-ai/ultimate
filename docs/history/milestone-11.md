# Roadmap milestone 11 — the deploy proof, and the gaps closed on the way

Moved out of the root `CLAUDE.md` on 2026-09-23 (plan 101, slice 17 f): live status is [`docs/idea/14-roadmap.md`](../idea/14-roadmap.md).

Open: roadmap milestone 11's two-platform deploy proof — 1.1.0 gave a scaffolded app a real
deployable artifact (`packages/cli/src/serve.ts`; `x new` writes `apps/web/server.ts`,
`prerender.ts`, a Dockerfile and `docker-compose.prod.yml`; `ROLE=migrate` runs release-phase
migrations), and **4.0.0 gave it a chart** — `x new` writes `docker/helm`, 8 files: a
`Deployment` for each of the four roles enabled by default (`web`, `sync`, `worker`, `scheduler`),
`replicator` behind `enabled: false`, and `migrate` as a `Job` rather than a Deployment. So
`x deploy --method helm` runs `helm upgrade --install` against it with nothing to copy in. What is still missing is the **proof**, which is the milestone: the demo app on
Compose **and** K8s from one image, with an invisible rolling restart, has not been demonstrated.
Two things had to be true before it could be, and each was false in turn — until 2.0.0 `sync`'s
readiness probe polled a port the process never opened, and until 4.0.0 a scaffolded app had no
chart at all and `--method helm` exited `X_NOT_IMPLEMENTED`. Of the four known gaps
named in [`CHANGELOG.md`](../../CHANGELOG.md), **all four are closed in 2.0.0**, `As of 2026-08`:

| Gap | State |
|---|---|
| `x build --target binary` compiled and crashed at import | **fixed, and now proven** — the version read is lazy and `x build` passes `--define ULTIMATE_FRAMEWORK_VERSION`. `docker/Dockerfile` passes it too as of 2.0.0; it had not, so the target was fixed everywhere except in the artifact the framework ships. The image build now ends in `/out/app --version`, so a binary that cannot answer fails the build rather than the first command an operator runs |
| the shared cache tier's Lua invalidation `DEL`s keys it never declares in `KEYS` | **fixed** — the script returns the member list and the tier deletes value keys client-side, one key per `DEL`, so it is slot-local on Redis Cluster and Dragonfly |
| `docker-compose.prod.yml` pairs a published host port with `replicas` above 1 | **fixed** — a published host port has exactly one binder (reproduced: the second replica dies with `Bind for 0.0.0.0:3000 failed: port is already allocated`), so `web` and `sync` declare `replicas: 1` in all four files — framework, both tracked apps, and `x new`'s scaffold. Scaling either is the reverse proxy you add or the chart's per-role HPA, both named in the file header: Compose is the ladder's single-node rung and the box is the availability story |
| `resolveEnvironment` exists in both `core` and `seo` with different return types | **fixed** — seo's is deleted; core's is the one reader of `ULTIMATE_ENV`, and `'preview'` is now core's `'staging'`. The half that was not obvious: `ULTIMATE_ENV` is **not in the env schema**, so nothing validates it at boot and a `robots.txt` render can be its first reader — hence `tryResolveEnvironment()` in core, which answers `undefined` rather than throwing, instead of a second resolver in seo |

Milestone detail: [`docs/idea/14-roadmap.md`](../idea/14-roadmap.md).
