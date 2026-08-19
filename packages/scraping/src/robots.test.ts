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

describe('unit · a hostile robots.txt cannot stall the worker', () => {
  // The shape the walk replaced, kept as the ORACLE: the semantics were right and only the cost
  // was wrong, so the new matcher has to agree with it everywhere it was cheap enough to ask.
  const byRegex = (pattern: string, path: string): boolean => {
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split('*')
      .map((literal) => literal.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
  };

  const PATTERNS = [
    '/private',
    '/private/',
    '/*.pdf$',
    '/*.pdf',
    '/a*b*c',
    '/a*b*c$',
    '*',
    '$',
    '/x$',
    '/re.ports+/(1)',
    '/f*',
    '/*',
    '/**/deep',
  ];
  const PATHS = [
    '/',
    '/private',
    '/private/public/page',
    '/reports/2026.pdf',
    '/reports/2026.pdf?download=1',
    '/abc',
    '/aXbYc',
    '/aXbYcZ',
    '/x',
    '/xy',
    '/re.ports+/(1)',
    '/f',
    '',
    '/a/b/deep',
  ];

  test('the walk answers exactly what the compiled pattern answered', () => {
    for (const pattern of PATTERNS) {
      for (const path of PATHS) {
        const rules = { rules: [{ allow: false, path: pattern }] };
        // `robotsAllows` inverts a match into a verdict, so a disagreement shows up as a flipped
        // boolean rather than as a silent near-miss.
        expect([pattern, path, robotsAllows(rules, path)]).toEqual([
          pattern,
          path,
          !byRegex(pattern, path),
        ]);
      }
    }
  });

  test('a wildcard-dense rule matches in linear time, not by backtracking', () => {
    // Remote text: robots.txt comes from the site being scraped. 24 wildcards against a
    // non-matching path is minutes of backtracking for a regex built by splitting on `*`.
    const rules = { rules: [{ allow: false, path: `/${'a*'.repeat(24)}b` }] };
    const started = performance.now();
    expect(robotsAllows(rules, `/${'a'.repeat(60)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
