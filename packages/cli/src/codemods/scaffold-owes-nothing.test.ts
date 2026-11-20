// What `x new` writes owes no codemod, at any release: every codemod, dry-run over each scaffold
// the CLI can plan, changes nothing. So `x doctor`'s X_UPGRADE_CODEMODS_PENDING on a fresh app is a
// broken template or a codemod that rewrites what is already current, never a stamp that moved.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';
import { NEW_SHAPES } from '../new-shapes';
import { memoryCodemodApp } from './codemod';
import { runCodemods } from './engine';
import { CODEMODS } from './index';

const PLANS = [
  { label: 'x new', options: { name: 'shop', example: true } },
  { label: 'x new --no-example', options: { name: 'shop', example: false } },
  ...NEW_SHAPES.map((shape) => ({
    label: `x new --shape ${shape}`,
    options: { name: 'shop', example: false, shape },
  })),
];

describe('unit · a fresh scaffold owes no codemod', () => {
  for (const { label, options } of PLANS) {
    test(label, async () => {
      const files: Record<string, string> = {};
      for (const file of planNewApp(options)) {
        if (typeof file.contents === 'string') files[file.path] = file.contents;
      }
      const report = await runCodemods({
        app: memoryCodemodApp(files),
        codemods: CODEMODS,
        from: '0.0.0',
        to: '999.0.0',
        dryRun: true,
      });
      const owed = report.applied
        .filter((one) => one.changed.length > 0)
        .map((one) => ({ id: one.id, changed: one.changed }));
      expect(owed).toEqual([]);
    });
  }
});
