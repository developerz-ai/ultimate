import { describe, expect, test } from 'bun:test';
import { cspHashSource } from '@ultimat3/http';
import { HYDRATE_RUNTIME_BODIES, STREAM_REVEAL_BODIES } from '@ultimat3/render';
import { inlineScriptSources } from './script-csp';

describe('unit · every inline script a served document can carry is hashed', () => {
  test('the stream reveal is admitted beside the hydration runtime', () => {
    const sources = inlineScriptSources();
    for (const body of [...HYDRATE_RUNTIME_BODIES, ...STREAM_REVEAL_BODIES]) {
      expect(sources).toContain(cspHashSource(body));
    }
    expect(STREAM_REVEAL_BODIES.length).toBeGreaterThan(0);
  });

  test('extra sources ride along, deduplicated and sorted', () => {
    const extra = cspHashSource('theme()');
    const sources = inlineScriptSources([extra, extra]);
    expect(sources.filter((one) => one === extra)).toHaveLength(1);
    expect([...sources].sort()).toEqual([...sources]);
  });
});
