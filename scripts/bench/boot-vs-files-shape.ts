// The pure half of `boot-vs-files.bench.ts`: the synthetic app module it writes N of, and the
// median it reports. Split from the harness so the fixture's shape is tested without importing it.

/** The file counts measured: the reference app's order of magnitude, 4×, and the plan's 5k app. */
export const DEFAULT_FILE_COUNTS: readonly number[] = [500, 2_000, 5_000];

/** `mod-00042.ts` — zero-padded, so a lexical sort is the numeric one the scan uses. */
export const moduleName = (index: number): string => `mod-${String(index).padStart(5, '0')}.ts`;

/**
 * One app module: an `entity()` with five columns (what most files in an app register), and every
 * tenth one referencing the module before it — an app's files are a graph, not a flat list.
 */
export function moduleSource(index: number): string {
  const table = `bench_t${String(index)}`;
  const parent = index % 10 === 0 && index > 0 ? index - 1 : undefined;
  const lines = [
    "import { entity, text, timestamp, uuid } from '@ultimat3/entity';",
    ...(parent === undefined
      ? []
      : [`import { t${String(parent)} } from './${moduleName(parent).replace(/\.ts$/, '')}';`]),
    `export const t${String(index)} = entity('${table}', {`,
    '  columns: {',
    '    id: uuid().primaryKey(),',
    parent === undefined
      ? '    parentId: uuid().nullable(),'
      : `    parentId: uuid().references(() => t${String(parent)}.id).nullable(),`,
    '    title: text(),',
    '    body: text().nullable(),',
    '    createdAt: timestamp().defaultNow(),',
    '  },',
    '});',
    `export const label${String(index)} = (title: string): string => \`${table}:\${title}\`;`,
    '',
  ];
  return lines.join('\n');
}

/** The middle value of an odd-length list of timings, or the lower middle of an even one. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}
