// The scaffolded app icon is the one source `@ultimat3/pwa` derives every install icon from. It
// has to be bytes `@ultimat3/core`'s image pipeline can actually decode — the pipeline reads PNG
// and JPEG only — so these tests pin the shape a silent regression would otherwise break quietly:
// an app that scaffolds with an icon nothing can ever turn into `/icons/icon-192.png`.

import { describe, expect, test } from 'bun:test';
import { probeImage } from '@ultimat3/core';
import { BuiltinImagePipeline } from '@ultimat3/pwa';
import { planNewApp } from './cmd-new';
import { icon } from './templates/scaffold-icon';

/** The scaffolded bytes, proven to be bytes — `contents` is `string | Uint8Array`. */
function iconBytes(): Uint8Array {
  const file = planNewApp({ name: 'demo-app', example: false }).find(
    (candidate) => candidate.path === 'apps/web/site/icon.png',
  );
  expect(file).toBeDefined();
  const contents = file?.contents;
  expect(contents).toBeInstanceOf(Uint8Array);
  return contents instanceof Uint8Array ? contents : new Uint8Array();
}

describe('unit · x new · scaffolded icon', () => {
  test('emits apps/web/site/icon.png, never the old icon.svg', () => {
    const paths = planNewApp({ name: 'demo-app', example: false }).map((file) => file.path);
    expect(paths).toContain('apps/web/site/icon.png');
    expect(paths).not.toContain('apps/web/site/icon.svg');
  });

  // The load-bearing assertion: this is what proves the source icon is decodable by the pipeline
  // that @ultimat3/pwa feeds it through — a byte-for-byte guarantee `.svg` could never make.
  test('the icon is a real, pipeline-decodable 1024x1024 PNG', () => {
    const info = probeImage(iconBytes());
    expect(info.format).toBe('png');
    expect(info.width).toBe(1024);
    expect(info.height).toBe(1024);
  });

  // The end of the chain: scaffolded source -> pwa's pipeline -> the exact PNG the generated web
  // manifest names. A source the pipeline cannot decode fails here, not on an install nobody watches.
  test('the icon bytes survive a BuiltinImagePipeline resize to 192x192', async () => {
    const png = await new BuiltinImagePipeline().resize(iconBytes(), { size: 192, padding: 0.1 });
    expect(probeImage(png)).toMatchObject({ format: 'png', width: 192, height: 192 });
  });

  test('icon() is deterministic: the same bytes on every call', () => {
    expect(icon()).toEqual(icon());
  });
});
