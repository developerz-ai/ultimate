// The combobox's suggestion pass: the datalist, the status class and the count all read the
// matches, and under a real Solid runtime they share one filter over the options. The filter's
// own ranking rules are proven in `combobox-filter.test.ts`.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, nodesOf } from '@ultimat3/core/render-nodes';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Combobox } from './Combobox';
import { type ComboboxOption, filterOptions } from './combobox-filter';

type Solid = typeof import('solid-js');

async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

const CITIES = ['Berlin', 'Bern', 'Zürich', 'Basel'];

/** Options whose every `hint` read is counted: the filter reads it per option per pass. */
const counted = () => {
  const reads = { hint: 0 };
  const options = CITIES.map((value) =>
    Object.defineProperty({ value }, 'hint', {
      enumerable: true,
      get: () => {
        reads.hint += 1;
        return `city ${value}`;
      },
    }),
  ) as ComboboxOption[];
  return { options, reads };
};

describe('Combobox under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });
  afterEach(clearSolidRuntime);

  test('the datalist, the status and its count share one filter pass', () => {
    const { options, reads } = counted();
    const matched = filterOptions(options, 'ber');
    const pass = reads.hint;
    expect(matched.length).toBe(2);

    const { createContext, useContext, createSignal, createMemo, createEffect, onCleanup } = solid;
    setSolidRuntime({
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot: solid.createRoot,
    });
    reads.hint = 0;
    let output: unknown;
    solid.createRoot((dispose) => {
      output = Combobox({ options, value: 'ber', 'aria-label': 'City' });
      dispose();
    });
    // One pass, plus the one `label={option.hint}` each rendered suggestion reads.
    expect(reads.hint).toBe(pass + matched.length);
    expect(byTag(nodesOf(output), 'option')).toHaveLength(2);
  });
});
