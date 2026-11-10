// `adapter-ports`: a whole port is green; each missing part reds on its own, unless pinned; a pin
// that excuses nothing reds; a barrel installer and an unlisted port-shaped type red; a hand-edited
// page reds; and the repository itself is green.

import { describe, expect, test } from 'bun:test';
import type { AdapterPort } from '../packages/core/src/registrar';
import { type AdapterPortPins, adapterPortFindings, adapterPortResult } from './adapter-ports';
import type { AdapterPortFacts, PackageFact } from './lib/adapter-port-facts';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const ROW: AdapterPort = {
  port: 'widgets',
  pkg: '@ultimat3/widget',
  interface: 'WidgetStore',
  envDefault: 'memoryWidgetStore',
  conformance: 'widgetStoreConformance',
};

const PKG: PackageFact = {
  name: '@ultimat3/widget',
  adapterEntry: 'packages/widget/src/adapter.ts',
  adapterTypes: ['WidgetRecord', 'WidgetStore'],
  adapterValues: ['installWidgetStore'],
  barrelInstallers: [],
};

const PINS: AdapterPortPins = {
  pending: {},
  barrel: {},
  unscanned: {},
  members: {},
  references: { widgets: { file: 'packages/widget/src/memory.ts', symbol: 'memoryWidgetStore' } },
  subjects: { widgets: 'store' },
};

/** A fully built port; `page` is filled with the render so the docs part holds. */
function facts(
  over: Partial<AdapterPortFacts> = {},
  pins: AdapterPortPins = PINS,
): AdapterPortFacts {
  const base: AdapterPortFacts = {
    fields: { widgets: 'WidgetStore' },
    bindings: {
      widgets: {
        phase: 'services',
        detail: 'installWidgetStore',
        installerFrom: ['@ultimat3/widget/adapter'],
      },
    },
    packages: { '@ultimat3/widget': PKG },
    conformance: ['widgetStoreConformance'],
    declared: (file, symbol) =>
      file === 'packages/widget/src/memory.ts' && symbol === 'memoryWidgetStore',
    ...over,
  };
  if (Object.hasOwn(over, 'page')) return base;
  return { ...base, page: adapterPortResult([ROW], base, pins).rendered };
}

const causes = (input: AdapterPortFacts, pins: AdapterPortPins = PINS): readonly string[] =>
  (adapterPortResult([ROW], input, pins).findings ?? []).map((one) => one.cause);

describe('adapter-ports', () => {
  test('a whole port is green, and --json lists its five parts', () => {
    const result = adapterPortResult([ROW], facts(), PINS);
    expect(result.findings).toEqual([]);
    expect(result.data).toEqual({
      pending: 0,
      ports: [
        {
          ...ROW,
          parts: { field: true, binding: true, adapter: true, conformance: true, docs: true },
        },
      ],
    });
  });

  test('a port with no RuntimeOverrides field reds on its field', () => {
    expect(causes(facts({ fields: {} }))).toEqual([
      'adapter port widgets (WidgetStore, @ultimat3/widget) is missing its field: PortValues has no widgets field',
    ]);
  });

  test('a pending or absent binding reds on its binding', () => {
    const pending = facts({
      bindings: { widgets: { phase: 'pending', detail: 'needs a default', installerFrom: [] } },
    });
    expect(causes(pending)).toEqual([
      'adapter port widgets (WidgetStore, @ultimat3/widget) is missing its binding: binding is pending: needs a default',
    ]);
    expect(causes(facts({ bindings: {} }))[0]).toContain(
      'missing its binding: no binding for widgets',
    );
  });

  test('no ./adapter subpath, an interface not on it, an installer off it: each reds on adapter', () => {
    const noSubpath = facts({
      packages: { '@ultimat3/widget': { ...PKG, adapterEntry: undefined } },
    });
    expect(causes(noSubpath)).toEqual([
      'adapter port widgets (WidgetStore, @ultimat3/widget) is missing its adapter: @ultimat3/widget has no ./adapter subpath',
    ]);
    const noType = facts({
      packages: { '@ultimat3/widget': { ...PKG, adapterTypes: ['WidgetRecord'] } },
    });
    expect(causes(noType)[0]).toContain(
      'packages/widget/src/adapter.ts does not export WidgetStore',
    );
    const barrelInstaller = facts({
      bindings: {
        widgets: {
          phase: 'services',
          detail: 'setWidgetStore',
          installerFrom: ['@ultimat3/widget'],
        },
      },
    });
    expect(causes(barrelInstaller)[0]).toContain(
      'the boot installs widgets with setWidgetStore from @ultimat3/widget, not from @ultimat3/widget/adapter',
    );
  });

  test('a read binding owes no installer on ./adapter', () => {
    const read = facts({
      bindings: { widgets: { phase: 'read', detail: 'serve-web.ts', installerFrom: [] } },
    });
    expect(causes(read)).toEqual([]);
  });

  test('a suite missing from @ultimat3/testing/conformance reds on conformance', () => {
    expect(causes(facts({ conformance: [] }))).toEqual([
      'adapter port widgets (WidgetStore, @ultimat3/widget) is missing its conformance: @ultimat3/testing/conformance does not export widgetStoreConformance',
    ]);
  });

  test('a hand-edited or absent page reds on docs, and --write is the fix', () => {
    const page = facts().page ?? '';
    const edited = adapterPortResult(
      [ROW],
      facts({ page: page.replace('memoryWidgetStore', 'x') }),
      PINS,
    );
    expect((edited.findings ?? []).map((one) => one.fix)).toEqual([
      'bun run scripts/adapter-ports.ts --write',
    ]);
    const intro = facts({ page: page.replace('four steps', 'three steps') });
    expect(causes(intro)).toEqual([
      'wiki/Adapters.md is not what ADAPTER_PORTS, PORT_REFERENCES and the ratchet render — it was edited by hand or a row moved without it',
    ]);
    const absent = adapterPortResult([ROW], facts({ page: undefined }), PINS);
    expect((absent.findings ?? []).map((one) => one.cause)).toEqual([
      'adapter port widgets (WidgetStore, @ultimat3/widget) is missing its docs: wiki/Adapters.md has no current section for widgets',
    ]);
  });

  test('a reference the cited file does not export reds', () => {
    expect(causes(facts({ declared: () => false }))).toEqual([
      'PORT_REFERENCES.widgets names memoryWidgetStore in packages/widget/src/memory.ts, which that file does not export — the page would send an author to copy code that is not there',
    ]);
  });

  test('a pinned part is excused and the page says pending; the pin gone stale reds', () => {
    const pins = { ...PINS, pending: { 'widgets#conformance': 'being written' } };
    const unbuilt = facts({ conformance: [] }, pins);
    expect(causes(unbuilt, pins)).toEqual([]);
    expect(unbuilt.page).toContain(
      '`behavesLike(widgetStoreConformance, () => store)` — *pending*: the suite is not on `@ultimat3/testing/conformance` yet',
    );
    expect(causes(facts({}, pins), pins)).toEqual([
      'PENDING_PARTS pins widgets#conformance, but that part now exists — the ratchet must tighten, or the next regression of it is excused',
    ]);
  });

  test('a set*/configure*/install* on a . barrel reds unless declared; a stale declaration reds', () => {
    const exported = facts({
      packages: { '@ultimat3/widget': { ...PKG, barrelInstallers: ['setWidgetStore'] } },
    });
    expect(causes(exported)[0]).toContain(
      '@ultimat3/widget exports setWidgetStore from its . barrel',
    );
    const declared = { ...PINS, barrel: { '@ultimat3/widget#setWidgetStore': 'configuration' } };
    expect(causes(exported, declared)).toEqual([]);
    expect(causes(facts({}, declared), declared)).toEqual([
      'BARREL_INSTALLERS names @ultimat3/widget#setWidgetStore, which no scanned barrel exports — the row excuses nothing',
    ]);
    const unscanned = { ...PINS, unscanned: { '@ultimat3/widget': 'test seams' } };
    expect(causes(exported, unscanned)).toEqual([]);
  });

  test('a port-shaped type on ./adapter that no row lists reds; a member does not; a stale member reds', () => {
    const extra = facts({
      packages: {
        '@ultimat3/widget': { ...PKG, adapterTypes: [...PKG.adapterTypes, 'GadgetDriver'] },
      },
    });
    expect(causes(extra)).toEqual([
      'packages/widget/src/adapter.ts exports GadgetDriver, a backend-shaped interface no ADAPTER_PORTS row lists — an app can implement it and has no runtime.ts field to hand it over',
    ]);
    const member = { ...PINS, members: { '@ultimat3/widget#GadgetDriver': 'widgets: a member' } };
    expect(causes(extra, member)).toEqual([]);
    expect(causes(facts({}, member), member)).toEqual([
      'PORT_MEMBERS names @ultimat3/widget#GadgetDriver, which no ./adapter subpath exports — the row excuses nothing',
    ]);
  });

  test('every finding is X_ADAPTER_PORT_INCOMPLETE with a fix that opens runnable', () => {
    const broken = facts({ fields: {}, conformance: [], page: undefined });
    for (const finding of adapterPortResult([ROW], broken, PINS).findings ?? []) {
      expect(finding.code).toBe('X_ADAPTER_PORT_INCOMPLETE');
      expect(finding.fix).toMatch(/^(?:bun run |readonly |export |\{ |"\.\/adapter")/);
    }
  });

  test(
    'the repository is green',
    async () => {
      expect(await adapterPortFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
