import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp, mkdir -p, or recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { cspHashSource } from '@ultimat3/http';
import { errorPageStyleBodies, inlineStyleBodies } from './error-page-csp';
import { ERROR_PAGE_DIR } from './error-pages';
import { inlineStyleSources } from './style-csp';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-error-csp-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writePage = async (status: number, html: string): Promise<void> => {
  await mkdir(join(root, ERROR_PAGE_DIR), { recursive: true });
  await Bun.write(join(root, ERROR_PAGE_DIR, `${String(status)}.html`), html);
};

describe('unit · <style> bodies are taken exactly as the browser hashes them', () => {
  test('untrimmed, in document order, attributes on the tag ignored', () => {
    const html = '<style>\n a{}\n</style><style media="print"> b{} </style>';
    expect(inlineStyleBodies(html)).toEqual(['\n a{}\n', ' b{} ']);
  });

  test('a page with no style block contributes nothing', () => {
    expect(inlineStyleBodies('<h1>Not found</h1>')).toEqual([]);
  });
});

describe("unit · the app's error pages are admitted to style-src", () => {
  test('an app with no error pages extends nothing', async () => {
    expect(await errorPageStyleBodies(root)).toEqual([]);
  });

  test('one entry per distinct body across every page, sorted and deduplicated', async () => {
    await writePage(404, '<style>b{}</style><style>a{}</style>');
    await writePage(500, '<style>a{}</style>');
    expect(await errorPageStyleBodies(root)).toEqual(['a{}', 'b{}']);
  });

  test('a stray non-html file in the directory is not read', async () => {
    await writePage(404, '<style>a{}</style>');
    await Bun.write(join(root, ERROR_PAGE_DIR, 'notes.txt'), '<style>zzz{}</style>');
    expect(await errorPageStyleBodies(root)).toEqual(['a{}']);
  });
});

describe("integration · the policy a boot builds admits the error page's own <style>", () => {
  // Both boots hand this module's answer to `startRoles({ inlineStyles })`, which hashes what
  // it is given (`inlineStyleSources`). Handed a hash, it hashed the hash: the page stayed blocked.
  test('what a boot hands startRoles hashes to the body the page carries', async () => {
    await writePage(404, '<style>a{}</style>');
    expect(inlineStyleSources(await errorPageStyleBodies(root))).toEqual([cspHashSource('a{}')]);
  });
});
