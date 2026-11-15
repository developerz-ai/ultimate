// `x g import-rows` — an uploaded csv read a page at a time, through a schema, into the slice's
// table. `importRows()` is a factory over `job()`, never a ninth primitive: a killed attempt
// resumes at its byte offset, and a refused row is reported by line, never by value.

import type { ExerciseEntry } from '../exercise-entry-edit';
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
): string => `// ${name.camel}: an uploaded csv of ${feature.plural}, into one org's rows. \`importRows()\` is a
// factory over job(), so a killed attempt resumes at its byte offset and the run is in the manifest.
// List this module in apps/web/api/index.ts's \`jobs:\` to register it.

${sortedImports([
  "import { importRows, t } from '@ultimat3/jobs';",
  "import { disk } from '@ultimat3/storage';",
  `import { db } from '${dbModule}';`,
])}

/** Where one org's uploads for this import sit: the only keys an import for that org may read. */
export const ${name.camel}Prefix = (orgId: string): string => \`imports/${name.kebab}/\${orgId}/\`;

export const ${name.camel} = importRows({
  // Pinned: the queue row, the step trace and every page's step carry this name.
  name: '${name.kebab}',
  // A pointer to the upload, never its rows. The key is the CALLER'S, so it is held to the org the
  // run is scoped to: \`tenant\` scopes the writes, and nothing else stops an import reading
  // another org's upload into this one. The run's dedupe key is the upload key, so it is per org.
  input: t.object({ orgId: t.uuid, key: t.string }).refine({
    name: 'key-in-own-org',
    message: 'key must sit under imports/${name.kebab}/<orgId>/ for the orgId this import names',
    check: ({ orgId, key }) => key.startsWith(${name.camel}Prefix(orgId)) && !key.includes('..'),
    path: ['key'],
  }),
  // The org the rows are written under is the input's: a scoped write fails closed without it.
  tenant: ({ orgId }) => orgId,
  // Thunks, read per page: the app's disks exist after boot, never at import.
  source: () => disk(),
  key: ({ key }) => key,
  format: 'csv',
  // The header must name exactly these, in any order.
  columns: ['id', 'title', 'priceMinor', 'priceCurrency'],
  // A row that fails this is reported by line and rule in the errors part, never by its value.
  schema: t.object({
    id: t.uuid,
    title: t.string,
    priceMinor: t.number.int(),
    priceCurrency: t.string,
  }),
  // At least once per page, so the write is idempotent: a replayed row collides on its primary
  // key and \`onMatch: 'nothing'\` writes nothing — never a row of another org.
  handle: async ({ rows, input }) => {
    await db.${feature.plural}.upsertAll(
      rows.map((row) => ({
        id: row.id,
        orgId: input.orgId,
        title: row.title,
        price: { minor: row.priceMinor, currency: row.priceCurrency },
      })),
      { onConflict: ['id'], onMatch: 'nothing' },
    );
  },
  errors: { sink: () => disk(), prefix: ({ orgId }) => \`imports/${name.kebab}/\${orgId}/errors\` },
});
`;

const jobSuite = (
  name: NameSet,
): string => `// ${name.camel}'s durable identity: a job scoped to the org its input names. The pass itself —
// the rows it writes and the rows it refuses — is the unit suite's, next door.

import { memoryJobDriver } from '@ultimat3/jobs';
import { beforeAll, expect, jobTest, swapAdapter } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// The queue is a process-global adapter port, so it is swapped for this file and put back after.
beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

const orgId = '00000000-0000-4000-8000-000000000002';
const input = { orgId, key: \`imports/${name.kebab}/\${orgId}/one.csv\` };

jobTest('is a job scoped to the org its input names', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.tenantFor(input)).toBe(input.orgId);
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});
`;

const unitSuite = (
  name: NameSet,
  feature: NameSet,
  dbModule: string,
): string => `// ${name.camel}, RUN: one pass by a worker in this process, from a memory disk into the in-memory
// driver. What is worth failing on: rows land under the input's org, a bad row is refused by line,
// and a replay writes nothing twice.
${rowsTestHead(name, feature, dbModule, [name.camel, `${name.camel}Prefix`])}
const idA = '00000000-0000-4000-8000-0000000000a1';
const idB = '00000000-0000-4000-8000-0000000000b2';

const upload = (key: string, lines: readonly string[]) =>
  disk.put(key, new TextEncoder().encode(\`\${lines.join('\\n')}\\n\`));

/** An upload key under \`orgId\`'s own prefix: the only kind an import for that org may read. */
const keyOf = (orgId: string, file: string): string => \`\${${name.camel}Prefix(orgId)}\${file}\`;

const titlesOf = (orgId: string): Promise<readonly string[]> =>
  inOrg(orgId, async () => (await db.${feature.plural}.all()).map((row) => row.title).toSorted());

unitTest('writes the valid rows under the input org, refuses the rest', async ({ runJobs }) => {
  await upload(keyOf(orgA, 'one.csv'), [
    'id,title,priceMinor,priceCurrency',
    \`\${idA},first,1250,USD\`,
    'not-a-uuid,second,1,USD',
    \`\${idB},third,0,EUR\`,
  ]);
  const trace = await runJobs(${name.camel}, { orgId: orgA, key: keyOf(orgA, 'one.csv') });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toMatchObject({ rows: 2, rejected: 1 });
  expect(await titlesOf(orgA)).toEqual(['first', 'third']);
  expect(await titlesOf(orgB)).toEqual([]);
});

unitTest('a replayed upload writes nothing twice', async ({ runJobs }) => {
  await store(orgA, 'existing');
  const key = keyOf(orgA, 'again.csv');
  await upload(key, ['id,title,priceMinor,priceCurrency', \`\${idA},once,1,USD\`]);
  await runJobs(${name.camel}, { orgId: orgA, key });
  await runJobs(${name.camel}, { orgId: orgA, key });
  expect(await titlesOf(orgA)).toEqual(['existing', 'once']);
});

// The key is the caller's: an import for org A naming org B's upload is refused at the input,
// before a byte is read — so B's rows never land under A, and whether B's object exists is not said.
unitTest('another org upload is refused at the input, and nothing is read', async ({ runJobs }) => {
  await upload(keyOf(orgB, 'theirs.csv'), ['id,title,priceMinor,priceCurrency', \`\${idB},b,1,USD\`]);
  const theirs = keyOf(orgB, 'theirs.csv');
  for (const key of [theirs, \`\${keyOf(orgA, '..')}/\${orgB}/theirs.csv\`]) {
    const [run] = (await runJobs(${name.camel}, { orgId: orgA, key })).executions;
    // Terminal on its first attempt, with no step run: the object was never opened.
    expect(run?.outcome).toBe('dead-lettered');
    expect(run?.code).toBe('X_VALIDATION_FAILED');
    expect(run?.steps).toEqual([]);
  }
  expect(await titlesOf(orgA)).toEqual([]);
});
`;

/**
 * The job's entry in `apps/web/exercise.ts`: off, with its why. A draw names an upload key no
 * object sits at, and the pass seeds no storage — so the run is proven in its unit suite instead.
 */
const exerciseEntry = (name: NameSet): ExerciseEntry => ({
  name: name.kebab,
  value: [
    '{',
    `  off: 'reads an uploaded object, and the exercise pass seeds no storage — the whole pass runs in jobs/${name.kebab}.test.ts against a memory disk',`,
    '}',
  ].join('\n'),
});

/** The import and its job/unit suites in the feature's `jobs/`, the entity planted when absent. */
export function importRowsFiles(rawName: string, target: RowsOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  assertScaffoldRow('import-rows', name, target);
  const dir = `${target.surfaceDir}/${target.feature}/jobs`;
  const dbModule = target.dbModule ?? PLACEHOLDER_DB_MODULE;
  return [
    ...sliceFoundation(target, ['entity'], target.locales),
    {
      path: `${dir}/${name.kebab}.ts`,
      contents: source(name, feature, dbModule),
      exercise: exerciseEntry(name),
    },
    { path: `${dir}/${name.kebab}.job.test.ts`, contents: jobSuite(name) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: unitSuite(name, feature, dbModule) },
  ];
}
