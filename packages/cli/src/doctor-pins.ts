// `x doctor`'s pin check: an `@ultimat3/*` dependency written as a range (`^31.0.0`, `~31.4`) in
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

/** A spec naming a version through an operator. `workspace:*`, `file:` and `link:` name none. */
const isRange = (spec: string): boolean =>
  !EXACT.test(spec.trim()) && pinVersion(spec) !== undefined && !/^[a-z]+:/.test(spec.trim());

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
    const exact = pins.map(
      (pin) => `"${pin.name}": "${fact.installed.get(pin.name) ?? pinVersion(pin.spec) ?? ''}"`,
    );
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
