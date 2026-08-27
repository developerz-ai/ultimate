// The app's half of the error page: one file per status, read per request, served verbatim.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no path joiner — the rule `cmd-db.test.ts` records.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  ERROR_PAGE_DIR,
  errorPageDocument,
  errorPageHook,
  errorPageOverride,
  errorPageSource,
  STATIC_ERROR_PAGE,
} from './error-pages';

const ROOT = join(import.meta.dir, '..', '.error-pages-fixture');
const OWN = '<!doctype html><title>ours</title><h1>Gone fishing</h1>';

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('where an app puts one', () => {
  test('one path per status, beside the favicon the app already overrides there', () => {
    expect(ERROR_PAGE_DIR).toBe('apps/web/site/errors');
    expect(errorPageSource(404)).toBe('apps/web/site/errors/404.html');
    expect(errorPageSource(500)).toBe('apps/web/site/errors/500.html');
  });

  test('a status that is not a status reads no file at all', async () => {
    // The hook takes a number from the pipeline, and a path built from one that is not a status
    // is a path this process had no business assembling.
    for (const status of [0, 99, 600, 40.4, Number.NaN]) {
      expect(await errorPageOverride(ROOT, status)).toBeUndefined();
    }
  });
});

describe('which page wins', () => {
  test('the app has none: nothing to serve, so the framework renders', async () => {
    expect(await errorPageOverride(ROOT, 404)).toBeUndefined();
  });

  test("the app's file wins, byte for byte", async () => {
    await Bun.write(join(ROOT, errorPageSource(404)), OWN);
    expect(await errorPageOverride(ROOT, 404)).toBe(OWN);
    // Per status, never a wildcard: a file for 404 says nothing about a 500.
    expect(await errorPageOverride(ROOT, 500)).toBeUndefined();
  });

  test('the hook is that read, bound to one root', async () => {
    await Bun.write(join(ROOT, errorPageSource(503)), OWN);
    const hook = errorPageHook(ROOT);
    expect(await hook(503)).toBe(OWN);
    expect(await hook(404)).toBeUndefined();
  });

  test('a file dropped in while the process runs is picked up — no restart', async () => {
    const hook = errorPageHook(ROOT);
    expect(await hook(404)).toBeUndefined();
    await Bun.write(join(ROOT, errorPageSource(404)), OWN);
    expect(await hook(404)).toBe(OWN);
  });
});

describe('the document a static export carries', () => {
  test("is the framework's page, with both backlinks and no request row", async () => {
    expect(STATIC_ERROR_PAGE).toBe('404.html');
    const page = await errorPageDocument(ROOT, 404);
    expect(page).toStartWith('<!doctype html>');
    expect(page).toContain('https://github.com/developerz-ai/ultimate');
    expect(page).toContain('https://www.developerz.ai');
    expect(page).not.toContain('⟦');
    expect(page).not.toContain('<dt>request</dt>');
  });

  test("is the app's own file when it has one", async () => {
    await Bun.write(join(ROOT, errorPageSource(404)), OWN);
    expect(await errorPageDocument(ROOT, 404)).toBe(OWN);
  });
});
