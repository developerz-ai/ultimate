// The stamp `roll-before-migrate` rewinds the scratch database to: one older build, never this one,
// written where `verifySchema` reads it — so every serving role meets a schema behind its build.

import { describe, expect, test } from 'bun:test';
import { behindStampSql, olderVersion } from './drill-schema-behind';
import {
  frameworkSchemaHash,
  parseStamp,
  STAMP_RELATION,
  stampVerdict,
} from './framework-schema-stamp';

describe('olderVersion', () => {
  test('the previous minor, else the previous patch, else the last major', () => {
    expect(olderVersion('31.28.0')).toBe('31.27.0');
    expect(olderVersion('31.0.4')).toBe('31.0.3');
    expect(olderVersion('31.0.0')).toBe('30.0.0');
  });
});

describe('behindStampSql', () => {
  test('a comment on the stamp relation naming only that older build', () => {
    const sql = behindStampSql('31.28.0');
    expect(sql.startsWith(`comment on table ${STAMP_RELATION} is '`)).toBe(true);
    const entries = parseStamp(sql.slice(sql.indexOf("'") + 1, -1));
    expect(entries.map((entry) => entry.version)).toEqual(['31.27.0']);
  });

  test('which leaves this build unapplied', () => {
    const sql = behindStampSql('31.28.0');
    const entries = parseStamp(sql.slice(sql.indexOf("'") + 1, -1));
    const mine = { version: '31.28.0', schema: frameworkSchemaHash() };
    expect(stampVerdict(entries, mine).applied).toBe(false);
  });
});
