// A job's input, seated in the tenant the pass enqueues it under. A job DECLARES its org as a
// function of its input (`tenant: (input) => input.orgId`), so a drawn input names a random org and
// the enqueue refuses it (`X_JOB_TENANT_MISMATCH`). The fields that function reads are found by
// reading them — a recording proxy, no field-name guess — and each is set to the seated tenant.

/** The handle's half the binder needs: `AnyJobHandle.tenantFor`, structurally. */
export interface TenantOf {
  readonly name: string;
  tenantFor(input: unknown): string | undefined;
}

/** `seated`: the input names the tenant. `fixed`: no field it reads moves the org it answers. */
export type JobTenantBinding =
  | { readonly kind: 'seated'; readonly input: unknown }
  | { readonly kind: 'fixed'; readonly declared: string | undefined };

type Path = readonly string[];

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

/** What `tenantFor` answered, or `undefined` for a throw: an unreadable input names no org. */
const answer = (handle: TenantOf, input: unknown): string | undefined => {
  try {
    return handle.tenantFor(input);
  } catch {
    return undefined;
  }
};

/** How deep an absent parent is filled in to read past it: `payload.input.orgId` is two. */
const ABSENT_DEPTH = 4;

/** The value at `path`, `undefined` when any step of it is absent. */
const getAt = (input: unknown, path: Path): unknown =>
  path.reduce<unknown>((value, key) => (isPlainObject(value) ? value[key] : undefined), input);

/** Every property path `tenantFor` read, at any depth of plain objects — a missing one included. */
function readOnce(handle: TenantOf, input: unknown): readonly Path[] {
  const read: Path[] = [];
  const watch = (value: unknown, at: Path): unknown =>
    !isPlainObject(value)
      ? value
      : new Proxy(value, {
          get(target, key, receiver) {
            if (typeof key !== 'string') return Reflect.get(target, key, receiver);
            const path = [...at, key];
            read.push(path);
            return watch(Reflect.get(target, key, receiver), path);
          },
        });
  answer(handle, watch(input, []));
  return read;
}

/**
 * Every path read, past absent parents too: a read that found nothing is filled with `{}` and read
 * again, so `payload.input.orgId` — a scoped backfill's tenant, its `input` left out of the
 * minimal draw — is found, not lost to the throw reading `orgId` of `undefined`.
 */
function pathsRead(handle: TenantOf, input: unknown, depth = 0): readonly Path[] {
  const reads = readOnce(handle, input);
  if (depth >= ABSENT_DEPTH) return reads;
  const deeper = reads
    .filter((path) => getAt(input, path) === undefined)
    .flatMap((path) => pathsRead(handle, setAt(input, path, {}), depth + 1));
  const seen = new Set<string>();
  return [...reads, ...deeper].filter((path) => {
    const key = JSON.stringify(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `input` with `path` set to `value`, copied along the path only. */
function setAt(input: unknown, path: Path, value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const base = isPlainObject(input) ? input : {};
  return { ...base, [head]: setAt(base[head], rest, value) };
}

/**
 * `input` naming `tenant` wherever `handle.tenantFor` reads it. A `'none'` job, or one already
 * naming it, comes back as given. A read path is kept only if setting it moves the answer to
 * `tenant` — a field read and then ignored is left as drawn.
 */
export function bindJobTenant(handle: TenantOf, input: unknown, tenant: string): JobTenantBinding {
  const declared = answer(handle, input);
  if (declared === tenant) return { kind: 'seated', input };
  const reads = pathsRead(handle, input);
  // `tenant: 'none'` is never called: no org named, none read, so none to disagree with.
  if (declared === undefined && reads.length === 0) return { kind: 'seated', input };
  const moving = reads.filter((path) => answer(handle, setAt(input, path, tenant)) === tenant);
  const bound = moving.reduce<unknown>((value, path) => setAt(value, path, tenant), input);
  return moving.length > 0 && answer(handle, bound) === tenant
    ? { kind: 'seated', input: bound }
    : { kind: 'fixed', declared };
}
