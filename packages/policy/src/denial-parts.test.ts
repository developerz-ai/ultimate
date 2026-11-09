// One code and one reason out of every surface's denial shape — the MCP text above all, whose
// reason both primitive packages used to read as `<code>: <reason>`.

import { describe, expect, test } from 'bun:test';
import { denialCode, denialReason } from './denial-parts';
import type { SurfaceDenial } from './surfaces';

const mcp = (text?: string): SurfaceDenial => ({
  surface: 'mcp',
  isError: true,
  content: text === undefined ? [] : [{ type: 'text', text }],
});

describe('denialCode / denialReason', () => {
  test('every surface yields the same pair', () => {
    const shapes: readonly SurfaceDenial[] = [
      {
        surface: 'http',
        status: 401,
        problem: {
          title: 't',
          status: 401,
          detail: 'sign in: then retry',
          code: 'X_UNAUTHENTICATED',
        },
      },
      { surface: 'live', close: 4403, code: 'X_UNAUTHENTICATED', reason: 'sign in: then retry' },
      {
        surface: 'job',
        outcome: 'failed',
        retryable: false,
        code: 'X_UNAUTHENTICATED',
        reason: 'sign in: then retry',
      },
      mcp('X_UNAUTHENTICATED: sign in: then retry'),
    ];
    for (const denial of shapes) {
      expect([denialCode(denial), denialReason(denial)]).toEqual([
        'X_UNAUTHENTICATED',
        'sign in: then retry',
      ]);
    }
  });

  test('an MCP denial with no text, or no code, falls back to X_FORBIDDEN', () => {
    expect([denialCode(mcp()), denialReason(mcp())]).toEqual(['X_FORBIDDEN', 'denied']);
    expect([denialCode(mcp('nope')), denialReason(mcp('nope'))]).toEqual(['X_FORBIDDEN', 'nope']);
  });
});
