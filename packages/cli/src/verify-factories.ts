// The factory lint on the `unit` step: an app's `packages/db/factories.ts` exports `factories`, and
// every factory — bare and with each trait — must build a row its entity accepts and create one it
// stores (`@ultimat3/testing`'s `lintFactories`). No file is no factories: the step says nothing.

// why: a synchronous exists check decides whether the child is spawned at all.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Infer } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import type { Runner } from './exec';
import type { Finding } from './output';

/** The one place an app's factories live. One convention, so the gate can find them. */
export const FACTORIES_FILE = 'packages/db/factories.ts';
/** The export that file makes: a `FactorySet` (`Record<name, factory>`). */
export const FACTORIES_EXPORT = 'factories';

const CODE = 'X_TEST_FACTORY_INVALID';

const findingSchema = t.object({
  factory: t.string,
  trait: t.nullable(t.string),
  strategy: t.string,
  code: t.string,
  cause: t.string,
});
const reportSchema = t.array(findingSchema);
type LintFinding = Infer<typeof findingSchema>;

/**
 * Run in a CHILD, from the app's root: the factories and `lintFactories` must share the app's own
 * copy of `@ultimat3/testing` (the persister slot is module state), and the app's entities must not
 * register into this process's registries. The last stdout line is the report.
 */
const SCRIPT = `const mod = await import(\`\${process.cwd()}/${FACTORIES_FILE}\`);
const set = mod[${JSON.stringify(FACTORIES_EXPORT)}];
if (typeof set !== 'object' || set === null) {
  console.log(JSON.stringify([{ factory: '*', trait: null, strategy: 'build', code: '${CODE}', cause: '${FACTORIES_FILE} exports no ${FACTORIES_EXPORT} object' }]));
} else {
  const { lintFactories } = await import('@ultimat3/testing');
  console.log(JSON.stringify(await lintFactories(set)));
}`;

const label = (finding: LintFinding): string =>
  `${finding.factory}${finding.trait === null ? '' : `.with('${finding.trait}')`}.${finding.strategy}()`;

/** One finding per factory × trait × strategy, each naming what to edit. */
export const factoryFinding = (finding: LintFinding): Finding => ({
  code: CODE,
  cause: `${label(finding)} is refused: ${finding.code} — ${finding.cause}`,
  // A code shape to paste into the file, opened by what to change — never a sentence (`fix-prose`).
  fix:
    finding.trait === null
      ? `defaults: (n, ids) => ({ /* every column ${finding.factory}'s entity requires, valid */ })   // factory "${finding.factory}" in ${FACTORIES_FILE}`
      : `traits: { ${JSON.stringify(finding.trait)}: { /* only columns the entity declares, valid */ } }   // factory "${finding.factory}" in ${FACTORIES_FILE}`,
  docs: ERROR_DOCS_URL,
  at: FACTORIES_FILE,
});

/** The child's last stdout line, parsed — or one finding saying the file would not load. */
function readReport(stdout: string, stderr: string): readonly LintFinding[] {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return parse(reportSchema, JSON.parse(last));
  } catch {
    const reason = stderr.trim().split('\n').slice(-3).join(' ') || 'no report was printed';
    return [
      {
        factory: '*',
        trait: null,
        strategy: 'build',
        code: CODE,
        cause: `${FACTORIES_FILE} did not load: ${reason}`,
      },
    ];
  }
}

/** The lint's findings for the app at `root`; none when it keeps no factories file. */
export async function factoryFindings(root: string, runner: Runner): Promise<readonly Finding[]> {
  if (!existsSync(join(root, FACTORIES_FILE))) return [];
  const result = await runner(['bun', '--eval', SCRIPT], { cwd: root });
  return readReport(result.stdout, result.stderr).map(factoryFinding);
}
