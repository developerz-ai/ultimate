// A robots.txt past the byte cap: RFC 9309 §2.5 — a crawler parses AT LEAST the first 500 KiB, so
// the rules inside the cap still bind. Read as "no file" it was allow-everything for any site that
// padded its robots.txt. The cap itself (abandoned early, never held whole) is `robots-fetch.test.ts`.

import { describe, expect, test } from 'bun:test';
import { robotsGate } from './robots';
import { DEFAULT_ROBOTS_MAX_BYTES, robotsFetcher } from './robots-fetch';

const answering = (text: string) => () => Promise.resolve(new Response(text));

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · a robots.txt over the cap', () => {
  test('answers its first maxBytes, cut at the last whole line', async () => {
    const head = 'User-agent: *\nDisallow: /private\n';
    // The cap falls inside the third line: that partial line is never parsed as a rule.
    const body = `${head}Disallow: /half-a-rule-that-runs-past-the-cap\n`;
    const read = robotsFetcher({ maxBytes: head.length + 12, fetch: answering(body) });
    expect(await read('https://padded.test/robots.txt')).toBe(head);
  });

  test('a cap with no line end inside it fails closed, never "no file"', async () => {
    const read = robotsFetcher({ maxBytes: 16, fetch: answering('#'.repeat(64)) });
    expect(await read('https://one-line.test/robots.txt')).toEqual({
      unreachable: 'robots.txt over 16 bytes',
    });
  });

  test('a body exactly at the cap is the whole file, not a cut one', async () => {
    const text = 'User-agent: *\nDisallow: /x';
    const read = robotsFetcher({ maxBytes: text.length, fetch: answering(text) });
    expect(await read('https://exact.test/robots.txt')).toBe(text);
  });

  test('the gate enforces a Disallow from a file padded past the default cap', async () => {
    const padded = `User-agent: *\nDisallow: /\n${'#'.repeat(DEFAULT_ROBOTS_MAX_BYTES + 100 * 1024)}\n`;
    const gate = robotsGate({ policy: 'obey', fetch: answering(padded) });
    expect(await codeOf(gate.assertAllowed('https://padded.test/private/page'))).toBe(
      'X_SCRAPE_ROBOTS_DISALLOWED',
    );
  });
});
