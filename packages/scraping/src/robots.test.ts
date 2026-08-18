import { describe, expect, test } from 'bun:test';
import { createRobotsGate, parseRobots, robotsAllows } from './robots';

const FILE = `
# a comment
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$

User-agent: ultimate-scraper
Disallow: /nope
`;

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · robots.txt', () => {
  test('a group naming this agent REPLACES the wildcard group', () => {
    const mine = parseRobots(FILE, 'ultimate-scraper');
    expect(mine.rules).toEqual([{ allow: false, path: '/nope' }]);
    expect(robotsAllows(mine, '/private')).toBe(true);
  });

  test('the wildcard group applies when the file names no group for this agent', () => {
    const other = parseRobots(FILE, 'somebody-else');
    expect(robotsAllows(other, '/private')).toBe(false);
  });

  test('the longest match wins, so an explicit Allow beats a broader Disallow', () => {
    const rules = parseRobots(FILE, 'somebody-else');
    expect(robotsAllows(rules, '/private/public/page')).toBe(true);
    expect(robotsAllows(rules, '/private/secret')).toBe(false);
  });

  test('the two wildcards robots.txt defines, and only those', () => {
    const rules = parseRobots(FILE, 'somebody-else');
    expect(robotsAllows(rules, '/reports/2026.pdf')).toBe(false);
    expect(robotsAllows(rules, '/reports/2026.pdf?download=1')).toBe(true);
  });

  test('an empty Disallow means "everything is allowed", never "the empty path"', () => {
    const rules = parseRobots('User-agent: *\nDisallow:', 'anyone');
    expect(rules.rules).toEqual([]);
    expect(robotsAllows(rules, '/anything')).toBe(true);
  });
});

describe('unit · the gate', () => {
  test('obeying refuses a disallowed path with a code and a written-reason fix', async () => {
    const gate = createRobotsGate({
      policy: 'obey',
      fetchText: () => Promise.resolve('User-agent: *\nDisallow: /private'),
    });
    expect(await codeOf(gate.assertAllowed('https://example.test/private/x'))).toBe(
      'X_SCRAPE_ROBOTS_DISALLOWED',
    );
    expect(await codeOf(gate.assertAllowed('https://example.test/public'))).toBeUndefined();
  });

  test('one fetch per origin, whatever the run navigates', async () => {
    let fetches = 0;
    const gate = createRobotsGate({
      policy: 'obey',
      fetchText: () => {
        fetches += 1;
        return Promise.resolve('User-agent: *\nDisallow: /private');
      },
    });
    await gate.assertAllowed('https://example.test/a');
    await gate.assertAllowed('https://example.test/b');
    await gate.assertAllowed('https://other.test/c');
    expect(fetches).toBe(2);
  });

  test('an unreadable robots.txt allows — a missing file means no restrictions', async () => {
    const gate = createRobotsGate({ policy: 'obey', fetchText: () => Promise.reject(new Error()) });
    expect(await codeOf(gate.assertAllowed('https://example.test/private'))).toBeUndefined();
  });

  test('ignoring requires a written reason, and the gate carries it', async () => {
    const gate = createRobotsGate({ policy: { ignore: 'the user is scraping their own account' } });
    expect(gate.ignoredBecause).toBe('the user is scraping their own account');
    expect(await codeOf(gate.assertAllowed('https://example.test/private'))).toBeUndefined();
  });
});
