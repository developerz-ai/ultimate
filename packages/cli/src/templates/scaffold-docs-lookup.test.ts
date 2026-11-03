// Both convention files `x new` writes send an agent to the installed docs before it states a
// framework limit. Without the line, a scaffold's agent never learned `x docs` existed, and stale
// comments claiming gaps closed majors ago lived on in an adopter's tree.

import { describe, expect, test } from 'bun:test';
import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
import { names } from './naming';
import { docsFiles } from './scaffold-docs';

const app = names('ledger-demo');

const fileAt = (path: string): string =>
  String(docsFiles(app).find((file) => file.path === path)?.contents ?? '');

describe('unit · the convention files name the docs lookup', () => {
  for (const path of ['AGENTS.md', 'CLAUDE.md']) {
    test(`${path} names x docs and x errors explain`, () => {
      const text = fileAt(path);
      expect(text).toContain('bunx x docs "<question>"');
      expect(text).toContain('bunx x errors explain <CODE>');
    });
  }

  test('AGENTS.md still fits the size check the gate holds it to', () => {
    expect(new TextEncoder().encode(fileAt('AGENTS.md')).byteLength).toBeLessThan(
      AGENTS_MD_MAX_BYTES,
    );
  });
});
