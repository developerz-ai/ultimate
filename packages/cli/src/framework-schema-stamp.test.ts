// The stamp a migrate leaves and the verdict a serving role reads from it — pure, so every branch
// is asked here; `framework-schema.live.test.ts` asks a real server.

import { describe, expect, test } from 'bun:test';
import { FRAMEWORK_SCHEMA } from './framework-schema';
import {
  FrameworkSchemaUnappliedError,
  frameworkSchemaHash,
  nextStamp,
  parseStamp,
  type StampEntry,
  stampVerdict,
} from './framework-schema-stamp';

const v24: StampEntry = { version: '24.0.0', schema: 'aaaaaaaaaaaaaaaa' };
const v24b: StampEntry = { version: '24.0.1', schema: 'bbbbbbbbbbbbbbbb' };
const v25: StampEntry = { version: '25.0.0', schema: 'cccccccccccccccc' };

describe('unit · the framework schema stamp', () => {
  test('the schema hash is 16 hex and stable for one DDL', () => {
    expect(frameworkSchemaHash()).toMatch(/^[0-9a-f]{16}$/);
    expect(frameworkSchemaHash()).toBe(frameworkSchemaHash());
    expect(FRAMEWORK_SCHEMA.length).toBeGreaterThan(0);
  });

  test('a stamp round-trips, newest first, one entry per build', () => {
    const once = nextStamp(null, v24);
    const twice = nextStamp(nextStamp(once, v24b), v24);
    expect(parseStamp(once)).toEqual([v24]);
    expect(parseStamp(twice)).toEqual([v24, v24b]);
  });

  test('a stamp keeps the sixteen newest builds', () => {
    let stamp: string | null = null;
    for (let index = 0; index < 20; index += 1) {
      stamp = nextStamp(stamp, {
        version: `1.0.${index}`,
        schema: index.toString(16).padStart(16, '0'),
      });
    }
    const entries = parseStamp(stamp);
    expect(entries).toHaveLength(16);
    expect(entries[0]?.version).toBe('1.0.19');
  });

  test('anything that is not a stamp records no build', () => {
    expect(parseStamp(null)).toEqual([]);
    expect(parseStamp(undefined)).toEqual([]);
    expect(parseStamp('a comment somebody wrote')).toEqual([]);
    expect(
      parseStamp("ultimate-framework-schema\n24.0.0 nothex\n1'; drop 0123456789abcdef"),
    ).toEqual([]);
  });

  test('applied when this build is anywhere in the stamp — an old pod mid-rollout included', () => {
    expect(stampVerdict([v24b, v24], v24)).toEqual({ applied: true });
    expect(stampVerdict([v24], v24)).toEqual({ applied: true });
  });

  test('unapplied when the stamp is empty or lacks this build', () => {
    expect(stampVerdict([], v24)).toEqual({ applied: false });
    expect(stampVerdict([v24b], v24)).toEqual({ applied: false, newest: v24b });
  });

  test('a newest build of another major is skew: served, and named', () => {
    expect(stampVerdict([v25, v24], v24)).toEqual({ applied: true, skew: v25 });
  });

  test('the refusal names this build, the newest applied one, and the command that applies', () => {
    const error = new FrameworkSchemaUnappliedError({ mine: v24, newest: v24b });
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(error.fix).toBe('x db migrate');
    expect(error.cause).toContain('24.0.0');
    expect(error.cause).toContain('24.0.1');
    expect(new FrameworkSchemaUnappliedError({ mine: v24, newest: undefined }).cause).toContain(
      'carries no stamp',
    );
  });
});
