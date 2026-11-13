// `x doctor`'s pin check: an `@ultimat3/*` dependency written as a range (`^31.0.0`, `latest`) in
// any of the app's manifests. The framework moves in lockstep and `x new` pins exactly; a range is a
// silent upgrade on the next install, and two of them drift into the mixed set `x upgrade` refuses.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { Finding } from './output';
import { readManifests, readPins } from './upgrade-pins';
import { pinVersion, type UpgradePin } from './upgrade-plan';

export const PIN_RANGE = 'X_FRAMEWORK_PIN_RANGE';

/** What an installed package's manifest must say to name the version `bun install` resolved. */
const INSTALLED = t.object({ version: t.string });

/** An exact release, or a prerelease of one: what `x new` and `x upgrade` write. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `workspace:*`, `file:` and `link:` name a directory, never a version: nothing to move. */
const LOCAL = /^(?:workspace|file|link):/;

/** `npm:@ultimat3/core@^31.0.0` → its alias prefix and the spec it pins, the part after the last @. */
const aliasOf = (spec: string): { readonly prefix: string; readonly version: string } => {
  const trimmed = spec.trim();
  if (!trimmed.startsWith('npm:')) return { prefix: '', version: trimmed };
  const at = trimmed.lastIndexOf('@');
  return at <= 'npm:'.length
    ? { prefix: trimmed, version: '' }
    : { prefix: trimmed.slice(0, at + 1), version: trimmed.slice(at + 1) };
};

/**
 * Everything but an exact version or a local link moves on the next install: `^`/`~`, `*`, `x`,
 * a dist-tag (`latest`), a comparator pair (`>=31 <32`), a hyphen range — and an `npm:` alias is
 * judged on the spec it carries.
 */
const isRange = (spec: string): boolean =>
  !LOCAL.test(spec.trim()) && !EXACT.test(aliasOf(spec).version);

/** The value the fix writes: the installed version, else the range's floor, alias kept. */
const exactFor = (pin: UpgradePin, installed: ReadonlyMap<string, string>): string => {
  const { prefix, version } = aliasOf(pin.spec);
  const exact = installed.get(pin.name) ?? pinVersion(version);
  return exact === undefined
    ? `<the exact version: npm view ${pin.name} version>`
    : `${prefix}${exact}`;
};

export interface PinFact {
  readonly pins: readonly UpgradePin[];
  /** The version `bun install` resolved, per package name — what the exact pin should say. */
  readonly installed: ReadonlyMap<string, string>;
  /** The 1-based line of each pin, keyed `file` then `name`, where the probe read the text. */
  readonly lines?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** The rule, pure: one finding per manifest, naming every ranged pin in it and its exact value. */
export function pinRangeFindings(fact: PinFact): readonly Finding[] {
  const byFile = new Map<string, UpgradePin[]>();
  for (const pin of fact.pins.filter((one) => isRange(one.spec))) {
    byFile.set(pin.file, [...(byFile.get(pin.file) ?? []), pin]);
  }
  return [...byFile].map(([file, pins]) => {
    const exact = pins.map((pin) => `"${pin.name}": "${exactFor(pin, fact.installed)}"`);
    const line = fact.lines?.get(file)?.get(pins[0]?.name ?? '') ?? 1;
    return {
      code: PIN_RANGE,
      cause: `${file} pins ${pins.map((pin) => `${pin.name} ${pin.spec}`).join(', ')} as a range; the framework releases in lockstep, so the next install may move one package without the rest`,
      fix: `edit ${file}:${line} — write ${exact.join(', ')}; then: bun install && x doctor --json`,
      docs: ERROR_DOCS_URL,
      at: file,
    };
  });
}

/** The I/O half. A manifest that will not parse is `x upgrade`'s refusal; here it is nothing. */
export async function pinProbe(root: string): Promise<PinFact> {
  const manifests = await readManifests(root).catch(() => []);
  const pins = readPins(manifests);
  const lines = new Map<string, Map<string, number>>();
  for (const { file, text } of manifests) {
    const byName = new Map<string, number>();
    text.split('\n').forEach((row, index) => {
      const name = /"(@ultimat3\/[a-z0-9-]+)"\s*:/.exec(row)?.[1];
      if (name !== undefined && !byName.has(name)) byName.set(name, index + 1);
    });
    lines.set(file, byName);
  }
  const installed = new Map<string, string>();
  for (const name of new Set(pins.map((pin) => pin.name))) {
    const manifest: unknown = await Bun.file(join(root, 'node_modules', name, 'package.json'))
      .json()
      .catch(() => undefined);
    const parsed = INSTALLED.safeParse(manifest);
    if (parsed.issues === undefined)
      installed.set(name, (parsed.value as { version: string }).version);
  }
  return { pins, installed, lines };
}
