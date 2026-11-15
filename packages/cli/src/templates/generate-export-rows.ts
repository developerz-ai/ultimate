// `x g export-rows` — one org's rows of the slice's table, streamed to storage a page at a time.
// `exportRows()` is a factory over `job()`, never a ninth primitive: the export is retried,
// resumed from its cursor, deduped per artifact and in the manifest like any job.

import type { RowsOptions } from './generate-rows-slice';
import { assertScaffoldRow, rowsTestHead } from './generate-rows-slice';
import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import { sliceFoundation } from './slice-foundation';

const source = (
  name: NameSet,
  feature: NameSet,
  dbModule: string,
): string => `// ${name.camel}: one org's ${feature.plural}, as csv parts in storage. \`exportRows()\` is a
// factory over job(), so the export is retried, resumes from its cursor and is in the manifest.
// List this module in apps/web/api/index.ts's \`jobs:\` to register it.

${sortedImports([
  "import { exportRows, t } from '@ultimat3/jobs';",
  "import { disk } from '@ultimat3/storage';",
  `import { db } from '${dbModule}';`,
])}
import type { ${feature.pascal} } from '../entity';

/** The columns, in order: the csv header, and the only keys a row may answer. */
export const ${name.camel}Columns = ['id', 'title', 'priceMinor', 'priceCurrency', 'createdAt'];

/**
 * One row's cells. Money as its integer minor units beside its currency, never a float; a date
 * as a UTC instant, never a zone-less format. Add a column here and in the list above together.
 */
export const ${name.camel}Row = (row: ${feature.pascal}) => ({
  id: row.id,
  title: row.title,
  priceMinor: row.price.minor,
  priceCurrency: row.price.currency,
  createdAt: row.createdAt.toISOString(),
});

export const ${name.camel} = exportRows({
  // Pinned: the queue row, the step trace and every part's step carry this name.
  name: '${name.kebab}',
  input: t.object({ orgId: t.uuid, exportId: t.string }),
  // The security boundary: an export concentrates one org's rows into one downloadable object,
  // so the run is scoped to the org its input names — and the read below to the same org.
  tenant: ({ orgId }) => orgId,
  prefix: ({ orgId, exportId }) => \`exports/${name.kebab}/\${orgId}/\${exportId}\`,
  source: ({ input }) => db.${feature.plural}.where({ orgId: input.orgId }),
  format: 'csv',
  columns: ${name.camel}Columns,
  row: ${name.camel}Row,
  // A thunk, read per write: the app's disks exist after boot, never at import.
  sink: () => disk(),
});
`;

const jobSuite = (
  name: NameSet,
): string => `// ${name.camel}'s durable identity: a job, one live pass per artifact. The pass itself — the rows it
// writes and the org it keeps to — is the unit suite's, next door.

import { memoryJobDriver } from '@ultimat3/jobs';
import { beforeAll, expect, jobTest, swapAdapter } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// The queue is a process-global adapter port, so it is swapped for this file and put back after.
beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

const input = { orgId: '00000000-0000-4000-8000-000000000002', exportId: 'weekly' };

jobTest('is a job scoped to the org its input names', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.tenantFor(input)).toBe(input.orgId);
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});

jobTest('enqueues once per artifact, and dedupes a second while one is live', async () => {
  const first = await ${name.camel}.enqueue(input);
  expect(first.deduped).toBe(false);
  const again = await ${name.camel}.enqueue(input);
  expect(again.deduped).toBe(true);
});
`;

const unitSuite = (
  name: NameSet,
  feature: NameSet,
  dbModule: string,
): string => `// ${name.camel}, RUN: one pass by a worker in this process, over rows in the in-memory driver, into
// a memory disk. What is worth failing on: the header, one org's rows and never another's.
${rowsTestHead(name, feature, dbModule, [name.camel, `${name.camel}Row`])}
const partText = async (orgId: string, exportId: string): Promise<string> => {
  const read = await disk.get(\`exports/${name.kebab}/\${orgId}/\${exportId}/part-00000.csv\`);
  return new TextDecoder().decode(read.bytes);
};

unitTest('one pass writes the org rows as csv, and no other org', async ({ runJobs }) => {
  await store(orgA, 'ours');
  await store(orgB, 'theirs');
  const trace = await runJobs(${name.camel}, { orgId: orgA, exportId: 'weekly' });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  const text = await partText(orgA, 'weekly');
  expect(text.split('\\n')[0]).toBe('id,title,priceMinor,priceCurrency,createdAt');
  expect(text).toContain('ours,1250,USD');
  expect(text).not.toContain('theirs');
});

unitTest('a row is its cells: integer minor units, its currency, a UTC instant', async () => {
  const stored = await store(orgA, 'one');
  expect(${name.camel}Row(stored)).toEqual({
    id: stored.id,
    title: 'one',
    priceMinor: 1250,
    priceCurrency: 'USD',
    createdAt: stored.createdAt.toISOString(),
  });
});
`;

/** The export and its job/unit suites in the feature's `jobs/`, the entity planted when absent. */
export function exportRowsFiles(rawName: string, target: RowsOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  assertScaffoldRow('export-rows', name, target);
  const dir = `${target.surfaceDir}/${target.feature}/jobs`;
  const dbModule = target.dbModule ?? PLACEHOLDER_DB_MODULE;
  return [
    ...sliceFoundation(target, ['entity'], target.locales),
    { path: `${dir}/${name.kebab}.ts`, contents: source(name, feature, dbModule) },
    { path: `${dir}/${name.kebab}.job.test.ts`, contents: jobSuite(name) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: unitSuite(name, feature, dbModule) },
  ];
}
