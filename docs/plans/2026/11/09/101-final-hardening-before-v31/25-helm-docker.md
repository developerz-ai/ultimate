# 25 — Helm and Docker: egress closed by default

> Part of [`overview.md`](overview.md). Depends on: none. Tier: `docker/` (this repo). Cluster-side changes are [`26`](26-infra.md), edited from the infrastructure repo.

## Verified clean — keep
`runAsNonRoot`, seccomp RuntimeDefault, read-only root FS, all capabilities dropped, no privilege escalation, `automountServiceAccountToken: false`, secrets via `existingSecret`, ingress NetworkPolicy, distroless `nonroot` image pinned by digest, `.dockerignore` excludes `.env*`/`.npmrc`/`.secrets.key`.

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| K1 | Low (amplifies [`16`](16-notify-pwa-scraping.md) N4) | `docker/helm/values.yaml:58` | `networkPolicy.egress: []` = no egress filtering; any pod (the scraping worker included) reaches `169.254.169.254` and the whole cluster | default egress: DNS (kube-dns), the declared services (Postgres, Redis, NATS, S3 by selector or CIDR value), public internet `0.0.0.0/0` **except** `169.254.0.0/16`, `100.64.0.0/10`, the cluster pod/service CIDRs (values with sane defaults), `fd00:ec2::254/128` |
| K2 | Low | Helm chart | no test that the default render carries the policy | helm template test |

## Files to change
- `docker/helm/values.yaml`, `docker/helm/templates/networkpolicy.yaml`, `docker/helm/README.md` (or the chart section in `docs/ops/`).
- `scripts/helm-template.test.ts` (or the existing chart test) — K2.

## Tests
- Default render has `policyTypes: [Egress]` and excludes `169.254.0.0/16`.
- `bun test scripts/helm-template.test.ts`

## Done when
- The deployed demo (after [`26`](26-infra.md) rolls it) cannot reach `169.254.169.254` from the worker pod (`kubectl exec … -- wget -T 2` refused; run by the infra slice).
