// The `input:` a fix pastes: the draw spread, plus each field the author has to supply.

import { describe, expect, test } from 'bun:test';
import { renderDrawnInput, renderExerciseKey, sampleGapBinding } from './exercise-hint';

describe('renderDrawnInput', () => {
  test('the bare spread when nothing is owed', () => {
    expect(renderDrawnInput([])).toBe('(drawn) => ({ ...drawn })');
  });

  test('a top-level field, its placeholder a JSON literal so a pattern survives the paste', () => {
    expect(renderDrawnInput([{ path: 'day', placeholder: '<must match ^\\d{4}$>' }])).toBe(
      '(drawn) => ({ ...drawn, day: "<must match ^\\\\d{4}$>" })',
    );
  });

  test('nested fields under one parent share its spread; an odd key is quoted', () => {
    expect(
      renderDrawnInput([
        { path: 'a.b', placeholder: '<x>' },
        { path: 'a.c', placeholder: '<y>' },
        { path: 'my-key', placeholder: '<z>' },
      ]),
    ).toBe(
      '(drawn) => ({ ...drawn, a: { ...(drawn.a as object), b: "<x>", c: "<y>" }, "my-key": "<z>" })',
    );
  });

  test('a gap at the root replaces the whole draw', () => {
    expect(renderDrawnInput([{ path: '', placeholder: '<p>' }])).toBe('() => "<p>"');
  });
});

describe('renderExerciseKey', () => {
  test('an identifier bare, anything else quoted', () => {
    expect(renderExerciseKey('publishPost')).toBe('publishPost');
    expect(renderExerciseKey('a b')).toBe('"a b"');
  });
});

describe('renderDrawnInput, deep', () => {
  test('each level casts the one above it, so the paste typechecks', () => {
    expect(renderDrawnInput([{ path: 'a.b.c', placeholder: '<x>' }])).toBe(
      '(drawn) => ({ ...drawn, a: { ...(drawn.a as object), b: { ...((drawn.a as Record<string, unknown>).b as object), c: "<x>" } } })',
    );
  });
});

describe('sampleGapBinding', () => {
  test("describeSampleGap's need becomes the placeholder; the root path is ''", () => {
    expect(sampleGapBinding('digest', 'digest (must match ^[0-9a-f]{64}$)')).toEqual({
      path: 'digest',
      placeholder: '<must match ^[0-9a-f]{64}$>',
    });
    expect(sampleGapBinding('ids', 'ids (needs at least 3 items)').placeholder).toBe(
      '<needs at least 3 items>',
    );
    expect(sampleGapBinding('(the input)', '(the input) (must match ^a$)')).toEqual({
      path: '',
      placeholder: '<must match ^a$>',
    });
    expect(sampleGapBinding('x', 'x').placeholder).toBe('<a value its schema accepts>');
  });
});
