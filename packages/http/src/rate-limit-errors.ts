// Every refusal a rate limit produces: the 429 a caller is answered with, and the six declaration
// faults the boot refuses. Split from `errors.ts` at the 500-line ceiling, on the seam it already
// had. The codes and their TITLES stay there, which is the one registry — `registerErrorCodes`
// must see them all in a single call.
import { HttpError } from './errors';

/**
 * The KEY never reaches the caller. `rateLimitKey` is `${routeName}|org:${orgId}` — or
 * `actor:${actorId}` — so the old cause handed an anonymous caller promoted to an org bucket the
 * internal org id, in a 429 anyone can provoke. It rides in `meta`, which the problem document
 * does not render and the error reporter does.
 */
export const rateLimited = (key: string, retryAfterSeconds: number): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMITED',
    cause: `the rate limit for this caller is exhausted; it refills in ${retryAfterSeconds}s`,
    fix: 'retry after the Retry-After header, or raise the bucket in configureHttp({ rateLimit: { buckets } }) at module scope in a file under apps/*/',
    meta: { key, retryAfterSeconds },
  });

/**
 * At `createServer`/`createPipeline`, never on the request. `replicas: 3` behind one config means
 * each process holds its own counters, so every configured number is enforced three times over —
 * a green `x verify` and a limit that is not the limit. The declaration is the app's because the
 * framework cannot see its replica count, and a framework that guessed would guess wrong.
 */
export const rateLimitNotShared = (found: 'process' | 'disabled'): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_NOT_SHARED',
    cause:
      found === 'disabled'
        ? "http.rateLimit.scope is 'shared' but http.rateLimit.enabled is false, so the fleet-wide limit is enforced nowhere"
        : "http.rateLimit.scope is 'shared' but the installed store keeps its counters in this process, so each replica would enforce the full bucket on its own",
    fix: "createServer({ routes, rateLimitStore: postgresRateLimitStore({ executor: { query: (text, values) => db().query({ text, values }) } }) }) — or defineHttpConfig({ rateLimit: { scope: 'process' } }) to accept per-replica limits",
  });

/**
 * The numbers of one bucket, spelled structurally so `errors.ts` stays free of an import from
 * `rate-limit.ts` — which imports this file.
 */
interface BucketNumbers {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

const numbers = (bucket: BucketNumbers): string => `${bucket.capacity} / ${bucket.refillPerSecond}`;

/**
 * Two declarations of one bucket, at `createServer`/`createPipeline`. Neither wins: an app that
 * configures `rateLimit.buckets.<name>` and a route that declares its own numbers under that name
 * disagree about what is enforced, and whichever a merge picked would leave the other a number
 * someone read and nothing applies — the failure this seam exists to end. The message speaks
 * capacity and refill rather than the `limit`/`windowMs` an action declares, because that is what
 * the limiter runs on; `toBucket` (`rate-limit.ts`, this package) is the conversion between them —
 * it lives here because http owns `Bucket` and the maths, and both tier-3 callers need it.
 */
export const rateLimitBucketConflict = (input: {
  bucket: string;
  /** `null` when the other declaration is the app's `configureHttp()` rather than a second route. */
  otherRoute: string | null;
  route: string;
  other: BucketNumbers;
  declared: BucketNumbers;
}): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_BUCKET_CONFLICT',
    cause: `bucket "${input.bucket}" has two declarations: ${
      input.otherRoute === null
        ? 'the rateLimit.buckets the app passed to configureHttp()'
        : `route "${input.otherRoute}"`
    } says ${numbers(input.other)}, route "${input.route}" says ${numbers(input.declared)} (capacity / refill per second)${
      input.otherRoute === null
        ? `; if ${numbers(input.other)} is what this deployment means to enforce, then the route's declaration is the half that is wrong and configureHttp() is not where to say so`
        : ''
    }`,
    // One edit, named. Two joined by "or" leaves the reader to decide which declaration is
    // authoritative — and the route is, always: it sits beside the handler and it is what the
    // OpenAPI operation publishes, so a config entry duplicating it is the copy that goes stale.
    fix:
      input.otherRoute === null
        ? `delete rateLimit.buckets.${input.bucket} from the app's configureHttp() call — the route's declaration is the one the OpenAPI operation publishes, so edit the numbers there if ${numbers(input.declared)} is wrong`
        : `rename the bucket route "${input.route}" declares — one name is one limit, and "${input.bucket}" is already route "${input.otherRoute}"'s`,
  });

/**
 * A route declares its own bucket and the INSTALLED limiter cannot enforce it — at
 * `createPipeline`, never on the request. `createRateLimiter` closes over the config it was built
 * with, so a limiter constructed before the routes existed resolves the route's bucket name
 * through `bucketFor`, misses, and falls through to `default`: measured at 120 burst and 21 of 21
 * requests allowed for a route declaring 5. Silent, and looser than what the author wrote.
 *
 * Refused rather than rebound, for two reasons. A `RateLimiter` is opaque — no store and no table
 * are reachable through it — so "binding" it would mean discarding the caller's limiter and the
 * store it carries, which is a different silent failure. And a caller who built their own limiter
 * may have meant their own numbers; picking for them is the precedence mistake
 * `X_RATE_LIMIT_BUCKET_CONFLICT` exists to refuse.
 */
export const rateLimitBucketUnbound = (input: {
  bucket: string;
  route: string;
  declared: BucketNumbers;
  /** What the limiter holds under that name, or `null` for "holds nothing / declares no table". */
  found: BucketNumbers | null;
}): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_BUCKET_UNBOUND',
    cause: `route "${input.route}" declares bucket "${input.bucket}" as ${numbers(input.declared)} (capacity / refill per second) and the installed limiter ${
      input.found === null
        ? 'does not hold that bucket, so the route would run on the default one'
        : `holds ${numbers(input.found)} for it`
    }`,
    fix: 'pass the STORE and let the pipeline build the limiter — createServer({ routes, rateLimitStore }) — so the bucket table is the one the routes registered',
  });

/**
 * At `defineHttpConfig`, never on the request. `scope` used to DEFAULT to `'process'`, so an app
 * that declared nothing enforced every configured number once per replica — three times over on
 * the chart this repo ships — with a green `x verify` and nothing to read. The boot check that
 * catches the other half (`assertRateLimitScope`) only fires for an app that said `'shared'`, so
 * the silent case was exactly the one nobody declared. One process is still a legal answer; it is
 * no longer an assumed one.
 */
export const rateLimitScopeUnset = (): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_SCOPE_UNSET',
    cause:
      'http.rateLimit is enabled and the deployment has not declared http.rateLimit.scope, so the numbers below it are per replica rather than per fleet',
    fix: "defineHttpConfig({ rateLimit: { scope: 'process' } }) if this app runs as ONE replica, or scope: 'shared' plus createServer({ routes, rateLimitStore: postgresRateLimitStore({ executor }) }) for a fleet-wide limit — a process booted by x dev or apps/web/server.ts derives it from the store it installed and never declares it",
  });

/**
 * At `defineHttpConfig`, never on the request, and the same shape as every other bucket-name
 * refusal here: `bucketFor` resolves an unknown name to `default`, so a tenant allowance an author
 * wrote as 5,000 would silently be the 120-burst read bucket — looser than the declaration, and
 * visible nowhere. A whole tenant's cap is not a value to discover by watching a graph.
 */
export const tenantBucketUnknown = (name: string, declared: readonly string[]): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN',
    cause: `rateLimit.tenantBucket names "${name}" and rateLimit.buckets declares ${
      declared.length === 0 ? 'no buckets' : declared.join(', ')
    }`,
    fix: `add ${name} to the same rateLimit.buckets — configureHttp({ rateLimit: { tenantBucket: '${name}', buckets: { ${name}: { capacity: 5000, refillPerSecond: 100 } } } }) — or drop tenantBucket to leave this app with no per-tenant allowance`,
    meta: { bucket: name },
  });

/**
 * The shared store ran its statement and answered nothing. An `insert … on conflict … returning`
 * always yields one row, so this is a driver that is not running what it was handed — a wrapped
 * client that swallows `returning`, or a pooler in a mode that discards it.
 *
 * 500 and never an allowed request: the invented decision would have to be "allowed", which is the
 * limiter switched off with nothing saying so. `@ultimat3/action`'s idempotency store makes the
 * same call in the same direction for the same reason.
 */
export const rateLimitStoreUnavailable = (statement: string): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_STORE_UNAVAILABLE',
    cause: `the shared rate-limit store answered no row for its ${statement} statement, so no limit was applied to this request`,
    fix: 'psql "$DATABASE_URL" -c "select * from x_rate_limit limit 1"   # then confirm the PgExecutor passed to postgresRateLimitStore returns the rows of `returning`',
  });

/**
 * A `{ limit, windowMs }` pair the limiter cannot run on. Raised by `toBucket` (`rate-limit.ts`),
 * which lives in this PACKAGE because http owns `Bucket` and the maths, and two tier-3 packages
 * (`action`, `query`) need the same conversion without importing each other.
 */
export const rateLimitInvalid = (input: {
  readonly owner: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly reason: string;
}): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_INVALID',
    cause: `"${input.owner}" declares rateLimit { limit: ${input.limit}, windowMs: ${input.windowMs} }: ${input.reason}`,
    fix: `edit the \`rateLimit:\` on ${input.owner} to a whole allowance over a real window — e.g. { limit: 5, windowMs: 600_000 } for five per ten minutes — or delete it to keep the default bucket`,
    meta: { owner: input.owner, limit: input.limit, windowMs: input.windowMs },
  });
