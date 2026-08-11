# Disaster recovery

A backup you have not restored is a hypothesis. Recovery has **two halves** and either one alone is
worthless: the **data** (your rows) and the **key** (the thing that decrypts every secret your
cluster needs to start). Lose the key and a complete set of database dumps rebuilds nothing.

## Objectives, stated honestly

| Objective | Target | Reality |
|---|---|---|
| RPO — maximum data loss | ≤ 24h | met by design: one logical dump per database per day. No WAL archiving, so writes since the last dump are at risk |
| RTO — time to restore | ≤ 1h | **a target, not a measurement**, until you have run a timed end-to-end drill and written down the wall clock |

Write your real numbers here. An RTO nobody has stopwatch-tested is a wish.

## The key plane

The secrets controller holds the **only** private key that can decrypt every sealed secret you have
committed. Back it up off-cluster, encrypted, daily.

| | |
|---|---|
| Source | the key Secret(s), selected **by label**, not by name — so rotation and additional active keys are captured |
| Method | export as YAML → encrypt to an asymmetric recipient (`age` or equivalent) → upload the ciphertext |
| Destination | `s3://<backups>/<controller>/<YYYY-MM-DD>.yaml.age` |
| Retention | **30 days** — longer than the database window, because the key changes rarely and losing it is catastrophic |
| At rest | encrypted. Object-store access alone must not be enough to decrypt |

**Where the two halves of the encryption key live:**

| Half | Where | Rule |
|---|---|---|
| Public recipient | committed, in the job's config | it can only encrypt — not a secret |
| Private key | a password manager, one item, nothing else | never committed, never logged, never passed through an agent session |

Rotating the recipient only affects **future** backups. Old ciphertext still needs the old private
key — so keep retired private keys until their backups age out.

### Restore the key

You have: the repo, object-store access, and the private key.

1. Stand up the cluster and install the controller. It mints a new, wrong key on first boot. Fine —
   you are about to overwrite it.
2. Pull the newest backup, decrypt, apply.
3. Restart the controller so it loads the restored key.
4. Verify a **real** committed sealed secret decrypts — not a probe you just created. Then destroy
   the local key file.

### Drill it, two ways

| Drill | Cadence | What it proves |
|---|---|---|
| Ephemeral-key cycle on a throwaway cluster in CI | weekly | the *mechanism* works: install → back up → wipe the live key → restore → seal a probe → assert round-trip. **No real secret and no production storage credential touches CI** |
| Real-key decrypt of the actual latest backup, run ad hoc from a trusted machine | on a schedule you keep | the *recovery* works — the only proof that matters |

The first without the second is a green check on a synthetic path.

## The data plane

Restore one database from one object. Destructive by definition, so it takes an explicit confirm
flag and nothing else.

```sh
# 1. list what exists — keys are deterministic, so this is the only lookup you need
aws s3 ls "s3://$BUCKET/postgres/<db>/" --endpoint-url "$S3_ENDPOINT"

# 2. restore
aws s3 cp "s3://$BUCKET/postgres/<db>/<YYYY-MM-DD>.sql.gz" - --endpoint-url "$S3_ENDPOINT" \
  | gunzip -c | psql -d <db>

# 3. verify — schema and row counts, not "it connected"
```

Validate that the object is a real gzip stream **before** touching the target database. Refuse a
missing target. Refuse a non-empty target without an explicit confirm.

### Restore drill

Weekly: for every database, restore the latest backup into a throwaway `<db>_drill`, assert that
schema and relation counts are greater than zero, drop the drill database. That proves the backups
are **loadable**. It does not measure RTO — see the honesty note above.

## The credential rule that protects the recovery floor

**The identity that writes backups must not be able to destroy them, and the identity that restores
must be a different, read-only one.**

An operator running this stack measured a single object-store access key shared byte-identically
across nine cluster Secrets — including the backup jobs, which run delete calls for retention, and
including the job that stores the controller-key DR copy. One host compromise would therefore have
handed an attacker not merely *read* of every backup but the ability to **delete the recovery floor
outright**. Encryption at rest protects one blob's confidentiality; it does nothing about deletion.

Three mitigations, in order of value:

| | |
|---|---|
| One credential per consumer | so a leak is scoped to one thing, and revocation does not take nine systems down |
| Object-store retention or object-lock on the backups bucket | so a delete call cannot actually remove the object within the retention window |
| A separate read-only credential for restore | the recovery path should not hold write rights it never uses |

You cannot audit any of this from the repo. Sealed ciphertext is scoped to `{namespace, name}`, so
identical plaintext necessarily seals to *different* blobs — a git diff can neither confirm nor
refute credential sharing. Only a live sweep of every value of every Secret answers it. Run one.

## Rebuild from nothing — the order

| # | Step | Blocked without |
|---|---|---|
| 1 | Provision nodes, install the cluster | — |
| 2 | Install the secrets controller, **restore its key** | the private encryption key |
| 3 | Install the GitOps controller, point it at the repo | repo access |
| 4 | Let platform services reconcile: ingress, certificates, monitoring | DNS pointing at the new ingress |
| 5 | Restore each tenant database | object-store read access |
| 6 | Let app manifests sync; the `migrate` role runs before any serving role | steps 2 and 5 |
| 7 | Verify per app — a real workflow, not an HTTP 200 | — |

Step 2 before step 3 is not negotiable. A GitOps controller that syncs before the key is restored
applies a fleet of sealed secrets that cannot decrypt, and every pod comes up in
`CreateContainerConfigError` at once.

## Ultimate-specific notes

| | |
|---|---|
| Migrations | the `migrate` role is run-once and exits non-zero on failure. In a rebuild it runs against a restored database, so its migration history must match the dump's — restore first, migrate second |
| The change feed | a `replicator` holds a replication slot. After a restore the slot is gone; the replicator recreates it and resumes from the current position, so changes that happened between the dump and the restore are not replayed downstream |
| The cache | do not restore it. It is regenerable, and a restored cache is stale data presented as fresh |
| Job state | lives in Postgres, so it restores with everything else. Jobs in flight at dump time will be re-claimed and re-run — this is why job steps must be idempotent |
| Verify with the app, not the platform | a `Synced` / `Healthy` GitOps status is reachability. Run a real user workflow |

## Write the incident down

Detect → contain → eradicate → recover → retrospective. Keep the timeline as you go; the parts you
will want later are the ones nobody thinks to record during.

Containment before root cause, always. And **coordinate before rotating a shared credential** — a
blind rotation cuts off every legitimate consumer at once, which is how a contained incident becomes
an outage.

Then commit the postmortem: TL;DR, what was confirmed, root cause, severity, containment, decisions,
plan. The point is that the next person — or the next agent — inherits the lesson instead of
rediscovering it. Every runbook in [`06-runbooks.md`](./06-runbooks.md) exists because somebody did
not have one.
