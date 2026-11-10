// Guards the one seam that keeps same-tier packages from importing each other: a registrar that
// resolved to `undefined`, or a second copy quietly winning the table, would split a kind's
// primitives across two registries and drop half of them with nothing raised.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ADAPTER_PORT_NAMES,
  ADAPTER_PORTS,
  type AdapterPortName,
  hasPrimitiveRegistrar,
  type ModuleRegistrar,
  PRIMITIVE_FACTORIES,
  PRIMITIVE_KINDS,
  PRIMITIVE_PACKAGES,
  primitiveRegistrar,
  type RegisteredPrimitive,
  registerPrimitiveRegistrar,
  resetPrimitiveRegistrars,
} from './registrar';

const noop: ModuleRegistrar = () => [];

const asQuery = (name: string): RegisteredPrimitive => ({ kind: 'query', name });

beforeEach(() => {
  resetPrimitiveRegistrars();
});

describe('registerPrimitiveRegistrar', () => {
  test('a kind is unresolvable until its owner announces one', () => {
    expect(hasPrimitiveRegistrar('query')).toBe(false);
    registerPrimitiveRegistrar('query', noop);
    expect(hasPrimitiveRegistrar('query')).toBe(true);
  });

  test('re-announcing the same function is a no-op', () => {
    registerPrimitiveRegistrar('query', noop);
    expect(() => registerPrimitiveRegistrar('query', noop)).not.toThrow();
    expect(primitiveRegistrar('query')).toBe(noop);
  });

  test('a second, different registrar for one kind is X_REGISTRAR_CONFLICT', () => {
    registerPrimitiveRegistrar('query', noop);
    const other: ModuleRegistrar = () => [];
    let code = '';
    try {
      registerPrimitiveRegistrar('query', other);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('X_REGISTRAR_CONFLICT');
  });

  test('kinds are independent', () => {
    registerPrimitiveRegistrar('query', noop);
    expect(hasPrimitiveRegistrar('action')).toBe(false);
  });
});

describe('the eight primitives', () => {
  /**
   * The rule that says "don't invent a ninth" is documented in four places and, until this
   * assertion, enforced in none — a ninth member of the union compiled like any other. This is
   * the build error. If a capability seems to need a new kind, it arrives as a factory over an
   * existing primitive instead: `llm()` returns an `action`, which is why a model call carries
   * every action projection without a ninth entry here.
   */
  test('are exactly these eight — a ninth is a design error, not a feature', () => {
    expect([...PRIMITIVE_KINDS]).toEqual([
      'action',
      'entity',
      'job',
      'mutator',
      'policy',
      'query',
      'route',
      'task',
    ]);
  });

  test('every one of them is a registrable kind, and each resolves only its own', () => {
    for (const kind of PRIMITIVE_KINDS) {
      resetPrimitiveRegistrars();
      registerPrimitiveRegistrar(kind, noop);
      const resolved = PRIMITIVE_KINDS.filter(hasPrimitiveRegistrar);
      expect(resolved).toEqual([kind]);
    }
  });
});

/**
 * The other half of "don't invent a ninth": the factories that already exist. Prose counted them
 * ("the fourth instance of the factory rule") in three files that could not see each other, so the
 * ordinal was wrong the moment a fifth landed. This table is what a new factory is added to.
 */
describe('PRIMITIVE_FACTORIES', () => {
  test('lists every shipped factory, each over one of the eight kinds', () => {
    // No COUNT here, and none in a test name below either — `scripts/primitive-factories.test.ts`
    // states the rule for this table and this file was breaking it: a title saying "the seven" was
    // wrong the moment an eighth landed, twice in one release, and a `toHaveLength(11)` beside a
    // spelled-out list is the same claim written twice. The LIST is the claim; this test only says
    // the table is non-empty and that every row is well formed.
    expect(PRIMITIVE_FACTORIES.length).toBeGreaterThan(0);
    for (const entry of PRIMITIVE_FACTORIES) {
      expect(PRIMITIVE_KINDS).toContain(entry.kind);
      expect(entry.pkg.startsWith('@ultimat3/')).toBe(true);
    }
  });

  test('the shipped rows, spelled out, so a table that lost one cannot pass', () => {
    // Sorted by package then factory name, which is what makes the list diffable and why NO
    // ordinal is derivable from it. `scripts/primitive-factories.test.ts` asks the other half of
    // the question — that every exported function returning an `Action` or a `JobHandle` has a row
    // here, and that every row has a function.
    expect(PRIMITIVE_FACTORIES.map((entry) => `${entry.pkg}#${entry.factory}`)).toEqual([
      // `@ultimat3/action` sorts before `@ultimat3/ai`: the common prefix is `@ultimat3/a`, and
      // `c` precedes `i`. Code-unit order, like every other sorted list this repo commits.
      '@ultimat3/action#transition',
      '@ultimat3/ai#agent',
      '@ultimat3/ai#agentJob',
      '@ultimat3/ai#hive',
      '@ultimat3/ai#llm',
      '@ultimat3/jobs#backfill',
      '@ultimat3/jobs#consumer',
      '@ultimat3/jobs#exportRows',
      '@ultimat3/jobs#importRows',
      '@ultimat3/jobs#ledger',
      '@ultimat3/jobs#partitions',
      '@ultimat3/jobs#purge',
      '@ultimat3/jobs#refreshView',
      '@ultimat3/jobs#reindex',
      '@ultimat3/jobs#rollup',
      '@ultimat3/jobs#subjectErase',
      '@ultimat3/jobs#subjectExport',
      '@ultimat3/jobs#webhook',
      '@ultimat3/jobs#webhookReceiver',
      '@ultimat3/mcp#mcpConfirmations',
      '@ultimat3/notify#notifier',
      '@ultimat3/notify#pushRegister',
      '@ultimat3/notify#pushUnregister',
      '@ultimat3/pwa#pushSubscribe',
      '@ultimat3/pwa#pushUnsubscribe',
      '@ultimat3/realtime#deviceSocket',
      '@ultimat3/scraping#pdf',
      '@ultimat3/scraping#scrape',
    ]);
  });

  test('is frozen, so a caller cannot grow the vocabulary at runtime', () => {
    expect(Object.isFrozen(PRIMITIVE_FACTORIES)).toBe(true);
  });

  test('every ROW is frozen too, so a caller cannot rewrite what a factory returns', () => {
    // A frozen array holding writable rows guards the LIST while leaving every value in it open —
    // the half that would have mattered, because `kind` is what `x affected` and the manifest read
    // to decide which primitive a factory produces. `readonly` is a compile-time claim; this is the
    // caller that has no types. A module is always strict, so the write THROWS rather than being
    // dropped in silence.
    expect(PRIMITIVE_FACTORIES.filter((entry) => !Object.isFrozen(entry))).toEqual([]);
    // The row's OWN kind, read before the write, never a literal: the list is sorted by package
    // then name, so `[0]` moves whenever a factory lands earlier in the alphabet — `transition`
    // (`@ultimat3/action`) took that slot and this assertion failed claiming `'action'` for a row
    // that is a `'mutator'`. A pin that breaks on a re-sort is testing the sort, not the freeze.
    const before = PRIMITIVE_FACTORIES[0]?.kind;
    const untyped = PRIMITIVE_FACTORIES[0] as unknown as { kind: string };
    expect(() => {
      untyped.kind = 'entity';
    }).toThrow(TypeError);
    expect(PRIMITIVE_FACTORIES[0]?.kind).toBe(before);
    expect(before).not.toBe('entity');
  });
});

describe('primitiveRegistrar', () => {
  test('returns the announced registrar, and its results carry the registered names', () => {
    const registrar: ModuleRegistrar = (module) => Object.keys(module).map(asQuery);
    registerPrimitiveRegistrar('action', registrar);
    expect(primitiveRegistrar('action')({ a: 1, b: 2 })).toEqual([asQuery('a'), asQuery('b')]);
  });

  test('throws X_REGISTRAR_MISSING with an installable fix rather than returning undefined', () => {
    let thrown: { code: string; fix: string } | undefined;
    try {
      primitiveRegistrar('query');
    } catch (error) {
      thrown = error as { code: string; fix: string };
    }
    expect(thrown?.code).toBe('X_REGISTRAR_MISSING');
    expect(thrown?.fix).toBe('bun add @ultimat3/query');
  });

  // `@ultimat3/${kind}` named packages that do not exist for half the kinds: a primitive's kind
  // is not its package, and a pasted `bun add @ultimat3/task` is a 404 from the registry.
  test.each([
    ['task', '@ultimat3/jobs'],
    ['job', '@ultimat3/jobs'],
    ['mutator', '@ultimat3/action'],
    ['route', '@ultimat3/render'],
    ['entity', '@ultimat3/entity'],
  ] as const)('the fix for a missing %s registrar names %s', (kind, pkg) => {
    try {
      primitiveRegistrar(kind);
      expect.unreachable();
    } catch (error) {
      expect((error as { fix: string }).fix).toBe(`bun add ${pkg}`);
    }
    registerPrimitiveRegistrar(kind, () => []);
    try {
      registerPrimitiveRegistrar(kind, () => []);
      expect.unreachable();
    } catch (error) {
      expect((error as { fix: string }).fix).toBe(`bun update ${pkg}`);
    }
  });

  test('every kind maps to a real workspace package', async () => {
    for (const kind of PRIMITIVE_KINDS) {
      const name = PRIMITIVE_PACKAGES[kind].replace('@ultimat3/', '');
      const manifest = Bun.file(new URL(`../../${name}/package.json`, import.meta.url));
      expect([kind, await manifest.exists()]).toEqual([kind, true]);
    }
  });
});

/**
 * Every backend an app may swap, one row each. `@ultimat3/cli`'s boot loops over this table and
 * `@ultimat3/testing`'s per-test override seam is keyed by its names, so a row that drifts from the
 * code it names is a slot nothing fills — spelled out here, and each name checked against the
 * owning package's source.
 */
describe('ADAPTER_PORTS', () => {
  test('the shipped rows, spelled out, so a table that lost one cannot pass', () => {
    expect(ADAPTER_PORTS.map((row) => `${row.port}=${row.pkg}#${row.interface}`)).toEqual([
      'aiGateway=@ultimat3/ai#Gateway',
      'auditSink=@ultimat3/core#AuditSink',
      'authLimiter=@ultimat3/auth#AuthLimiterFactory',
      'authServerStore=@ultimat3/auth#AuthServerStore',
      'cacheTiers=@ultimat3/cache#CacheTier',
      'clock=@ultimat3/core#SleepClock',
      'embedder=@ultimat3/ai#Embedder',
      'errorReporter=@ultimat3/core#ErrorReporter',
      'eventBus=@ultimat3/jobs#EventBus',
      'failureStore=@ultimat3/core#FailureStore',
      'idempotencyStore=@ultimat3/action#IdempotencyStore',
      'images=@ultimat3/seo#ImageTransformDriver',
      'isrStore=@ultimat3/render#IsrStore',
      'jobs=@ultimat3/jobs#JobDriver',
      'mail=@ultimat3/mail#MailDriver',
      'mcpConfirmationStore=@ultimat3/mcp#McpConfirmationStore',
      'meterStore=@ultimat3/action#MeterStore',
      'notifyStores=@ultimat3/notify#NotifyStores',
      'outboxStore=@ultimat3/jobs#OutboxStore',
      'purge=@ultimat3/cache#PurgeDriver',
      'pushSubscriptionStore=@ultimat3/pwa#PushSubscriptionStore',
      'rateLimitStore=@ultimat3/http#RateLimitStore',
      'scrapeDriver=@ultimat3/scraping#ScrapeDriver',
      'searchIndex=@ultimat3/entity#SearchIndex',
      'secretSource=@ultimat3/core#SecretSource',
      'semanticCache=@ultimat3/ai#SemanticCacheFactory',
      'smsTransport=@ultimat3/notify#SmsTransport',
      'storage=@ultimat3/storage#StorageDriver',
      'totpReplay=@ultimat3/auth#TotpReplayGuard',
      'transport=@ultimat3/realtime#Transport',
      'uploadScanner=@ultimat3/storage#UploadScanner',
    ]);
  });

  test('is sorted by port name and names each port once', () => {
    const names = ADAPTER_PORTS.map((row) => row.port);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...ADAPTER_PORT_NAMES]);
  });

  test('every row names a default, and a conformance suite spelled after its interface', () => {
    for (const row of ADAPTER_PORTS) {
      expect([row.port, row.envDefault.trim().length > 0]).toEqual([row.port, true]);
      const suite = `${row.interface.charAt(0).toLowerCase()}${row.interface.slice(1)}Conformance`;
      expect([row.port, row.conformance]).toEqual([row.port, suite]);
    }
  });

  test('every interface is exported by the package the row names', async () => {
    const glob = new Bun.Glob('src/**/*.ts');
    for (const row of ADAPTER_PORTS) {
      const pkg = row.pkg.replace('@ultimat3/', '');
      const dir = Bun.fileURLToPath(new URL(`../../${pkg}/`, import.meta.url));
      const declared = new RegExp(`export (interface|type) ${row.interface}\\b`);
      let found = false;
      for await (const file of glob.scan({ cwd: dir })) {
        if (file.endsWith('.test.ts')) continue;
        if (declared.test(await Bun.file(`${dir}${file}`).text())) {
          found = true;
          break;
        }
      }
      expect([row.port, found]).toEqual([row.port, true]);
    }
  });

  test('the table and every row in it are frozen', () => {
    expect(Object.isFrozen(ADAPTER_PORTS)).toBe(true);
    expect(ADAPTER_PORTS.filter((row) => !Object.isFrozen(row))).toEqual([]);
    const port: AdapterPortName = 'jobs';
    expect(ADAPTER_PORT_NAMES).toContain(port);
  });
});
