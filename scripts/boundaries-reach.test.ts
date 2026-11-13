// The tier table's prefilter: the parse-free bound on which packages a file's text can reach. A
// file whose bound is legal is never parsed, one the bound cannot clear (a path climbing out of its
// package) still is, and the package-edge graph stays exact. Split from `boundaries.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './boundaries';
import { checkBoundaries, packageEdges, reachableTargets } from './boundaries';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · the parse-free bound on what a file can reach', () => {
  test('every scoped name the text spells, and no bound at all once a path climbs two levels', () => {
    const at = (source: string) => reachableTargets(file('packages/core/src/a.ts', source));
    expect(at("import { t } from '@ultimat3/schema/x';\n// see @ultimat3/cli\n")).toEqual([
      'schema',
      'cli',
    ]);
    expect(at("import { x } from './sibling';\nimport { y } from '../up';\n")).toEqual([]);
    for (const climb of [
      '../../cli/src/x',
      '.././../cli/src/x',
      '../././../cli',
      '..\\/..\\/cli',
    ]) {
      expect(at(`import { x } from '${climb}';`)).toBeUndefined();
    }
  });

  test('a file the bound clears is never parsed, and one it cannot clear still is', () => {
    // Only legal targets in the text: nothing to report, whatever the parser would say.
    expect(
      checkBoundaries([file('packages/http/src/a.ts', "import { t } from '@ultimat3/schema';")]),
    ).toEqual([]);
    // A climb out of the package is read by the parser and reported.
    expect(
      checkBoundaries([
        file('packages/core/src/a.ts', "import { x } from '.././../cli/src/x';"),
      ]).map((violation) => violation.to),
    ).toEqual(['cli']);
  });

  test('the edges stay exact: a package named only in a comment is never an edge', () => {
    const edges = packageEdges([
      file('packages/http/src/a.ts', "import { t } from '@ultimat3/schema';"),
      // Its one candidate is already an edge: skipped, and it could add nothing.
      file('packages/http/src/b.ts', "import { u } from '@ultimat3/schema';"),
      // A candidate that is not yet an edge: parsed, and the comment adds nothing.
      file('packages/http/src/c.ts', '// once imported @ultimat3/core\nexport const c = 1;\n'),
    ]);
    expect([...(edges.get('http') ?? [])]).toEqual(['schema']);
  });
});
