// The enforcement half of `scripts/probe-databases.ts`: this file IS the build error. The real
// tree is asserted NON-VACUOUSLY — a scan that saw no `create database` would report a clean tree,
// which is the answer a correct tree gives too.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { corpus } from './lib/corpus';
import { fixShape } from './lib/fix-shape';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { fixedProbeDatabases, probeDatabaseFindings, probeDatabaseSites } from './probe-databases';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const FIXED = 'X_PROBE_DATABASE_FIXED';
const FILE = 'packages/a/src/x.live.test.ts';

const sites = (source: string) => fixedProbeDatabases(FILE, source);

describe('a database a test creates is named by probeDatabaseName', () => {
  test('a const holding a literal name is refused, at the line of the create', () => {
    const src = `const PROBE_DB = 'x_jobs_claim_live';
beforeAll(async () => {
  await admin(\`create database \${PROBE_DB}\`);
});
`;
    expect(sites(src)).toEqual([{ file: FILE, line: 3, name: 'PROBE_DB', literal: false }]);
  });

  test('a template interpolating only the pid is refused — two runs can share a pid', () => {
    const src = `const database = \`x_schema_load_\${process.pid}\`;
await admin.execute(raw(\`CREATE DATABASE \${database} template template0\`));
`;
    expect(sites(src).map((one) => one.name)).toEqual(['database']);
  });

  test('a name written straight into the statement is refused, quoted or not', () => {
    expect(sites("await admin('create database x_fixed');\n")).toHaveLength(1);
    expect(sites('await admin(\'create database "x_fixed"\');\n')).toHaveLength(1);
  });

  test('a name from probeDatabaseName is the passing shape', () => {
    const src = `const PROBE_DB = probeDatabaseName('x_jobs_claim_live');
await admin(\`create database \${PROBE_DB}\`);
`;
    expect(sites(src)).toEqual([]);
  });

  test('an assertion on SQL the code under test generated is a read, not a create', () => {
    const src = `expect(texts).toContain('create database "postly_branch_feat_x" template "postly"');
statements.some((sql) => sql.startsWith('CREATE DATABASE "ultimate_test_template_w'));
`;
    expect(sites(src)).toEqual([]);
  });

  test('a test title naming the statement is prose too', () => {
    expect(sites("test('clones via CREATE DATABASE ... TEMPLATE', async () => {});\n")).toEqual([]);
  });

  test('a comment naming the statement is prose', () => {
    expect(sites('// `CREATE DATABASE x_fixed` races the next worker\n')).toEqual([]);
  });

  test('a name the file does not declare (a parameter) is not this rule’s to judge', () => {
    const src = `const make = (db: string) => admin(\`create database \${db}\`);
`;
    expect(sites(src)).toEqual([]);
  });
});

describe('every spelling of the name slot is read (audit L2)', () => {
  const FIXED_DECL = "const DB = 'x_fixed';\n";

  test('a quoted interpolation is the same binding', () => {
    expect(sites(`${FIXED_DECL}await admin(\`create database "\${DB}"\`);\n`)).toHaveLength(1);
  });

  test('a concatenation names the binding after the plus', () => {
    expect(sites(`${FIXED_DECL}await admin('create database ' + DB);\n`)).toHaveLength(1);
    expect(sites(`${FIXED_DECL}await admin('create database "' + DB + '"');\n`)).toHaveLength(1);
  });

  test('a helper-wrapped interpolation names the binding it wraps', () => {
    expect(sites(`${FIXED_DECL}await sql\`create database \${sql(DB)}\`;\n`)).toHaveLength(1);
  });

  test('each of the three passes when the binding is a probe name', () => {
    const decl = "const DB = probeDatabaseName('x_ok');\n";
    for (const create of [
      `await admin(\`create database "\${DB}"\`);`,
      "await admin('create database ' + DB);",
      `await sql\`create database \${sql(DB)}\`;`,
    ]) {
      expect(sites(`${decl}${create}\n`)).toEqual([]);
    }
  });

  test('a simple alias of a probe binding is a probe name', () => {
    const src = `const PROBE_DB = probeDatabaseName('x_ok');
const OTHER = PROBE_DB;
await admin(\`create database \${OTHER}\`);
`;
    expect(sites(src)).toEqual([]);
  });

  test('and an alias of a fixed binding is still fixed', () => {
    const src = `const PROBE_DB = 'x_fixed';
const OTHER = PROBE_DB;
await admin(\`create database \${OTHER}\`);
`;
    expect(sites(src).map((one) => one.name)).toEqual(['OTHER']);
  });
});

describe('what the rule cannot follow is counted, never claimed', () => {
  test('a parameter and an unrecognised shape are unjudged, not passed', () => {
    const src = `const make = (db: string) => admin(\`create database \${db}\`);
await admin(\`create database \${names.probe}\`);
`;
    const scanned = probeDatabaseSites([{ path: FILE, source: src, masked: '', stripped: src }]);
    expect(scanned.creates).toBe(2);
    expect(scanned.fixed).toEqual([]);
    expect(scanned.unjudged.map((one) => one.line)).toEqual([1, 2]);
  });
});

describe('the finding', () => {
  test('names the file, the binding and the call that repairs it', () => {
    const findings = probeDatabaseFindings([
      { file: FILE, line: 3, name: 'database', literal: false },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(FIXED);
    expect(findings[0]?.at).toBe(`${FILE}:3`);
    expect(findings[0]?.fix).toContain(FILE);
    expect(findings[0]?.fix).toContain('bun run probe-databases');
    // It OPENS with the declaration to paste, renaming nothing (`bun run scripts/fix-prose.ts`).
    expect(findings[0]?.fix.startsWith("const database = probeDatabaseName('")).toBe(true);
    expect(fixShape(findings[0]?.fix ?? '')).toBe('code');
  });

  test('a literal name has no binding, so the fix declares one', () => {
    const [finding] = probeDatabaseFindings([
      { file: FILE, line: 1, name: 'x_fixed', literal: true },
    ]);
    expect(finding?.fix.startsWith("const PROBE_DB = probeDatabaseName('")).toBe(true);
    expect(finding?.cause).toContain('the literal x_fixed');
  });
});

describe('the real tree', () => {
  test('every database a test creates has a per-run name', async () => {
    const files = await corpus(repoRoot(), 'tests');
    const { creates, fixed, unjudged } = probeDatabaseSites(files);
    // Non-vacuity: the suites #705 migrated create databases, and the scan has to SEE them.
    expect(creates).toBeGreaterThan(10);
    expect(fixed).toEqual([]);
    // Every create in the tree today is one the rule can follow; a new unjudged one is a choice
    // to state here, not a silent pass.
    expect(unjudged).toEqual([]);
  });
});
