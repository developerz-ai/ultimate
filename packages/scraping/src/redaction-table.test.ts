// ONE table for both halves of by-value redaction, because they pull opposite ways: a secret must
// be caught in every spelling a page or a URL writes it in, and a credential-bearing URL must not
// hand the redaction set every ordinary word in its query. Each row is (where the value came from,
// the value, the text around it, what the text must read after the pass).

import { describe, expect, test } from 'bun:test';
import { createSecretBag, redactSecrets } from './secrets';
import { urlSecretValues } from './url-secrets';

const PASSWORD = 'p@ss word&1\'"<x>';
const BROWSER_ID = '0f8e2a1c-5b4a-4d3e-9f8e-7d6c5b4a3210';
const TOKEN = 'tok_live_9f8e7d6c5b4a3210';
const CDP_URL = `wss://connect.provider.test/devtools/browser/${BROWSER_ID}?token=${TOKEN}&stealth=true&proxy=residential&apiKey=k3y9&region=eu`;

interface Row {
  /** `secret`: a DECLARED secret's value. `url`: every value `urlSecretValues` hands `conceal()`. */
  readonly source: 'secret' | 'url';
  readonly value: string;
  readonly text: string;
  readonly expected: string;
}

const ROWS: readonly (Row & { readonly name: string })[] = [
  {
    name: 'the raw value',
    source: 'secret',
    value: PASSWORD,
    text: `pw ${PASSWORD} end`,
    expected: 'pw [redacted] end',
  },
  {
    name: 'percent-encoded (encodeURIComponent)',
    source: 'secret',
    value: PASSWORD,
    text: `/login?pw=${encodeURIComponent(PASSWORD)}&next=/`,
    expected: '/login?pw=[redacted]&next=/',
  },
  {
    name: 'form-encoded (space as +, quote and apostrophe escaped)',
    source: 'secret',
    value: PASSWORD,
    text: `pw=${new URLSearchParams({ pw: PASSWORD }).toString().slice(3)}&x=1`,
    expected: 'pw=[redacted]&x=1',
  },
  {
    name: 'HTML-escaped as text content (& < >)',
    source: 'secret',
    value: PASSWORD,
    text: '<p>p@ss word&amp;1\'"&lt;x&gt;</p>',
    expected: '<p>[redacted]</p>',
  },
  {
    name: 'HTML-escaped as an attribute value (& ")',
    source: 'secret',
    value: PASSWORD,
    text: '<i title="p@ss word&amp;1\'&quot;<x>">',
    expected: '<i title="[redacted]">',
  },
  {
    name: 'HTML-escaped by a server template (&#39;)',
    source: 'secret',
    value: PASSWORD,
    text: '<b>p@ss word&amp;1&#39;&quot;&lt;x&gt;</b>',
    expected: '<b>[redacted]</b>',
  },
  {
    name: 'HTML-escaped by a server template (&#x27;)',
    source: 'secret',
    value: PASSWORD,
    text: '<b>p@ss word&amp;1&#x27;&quot;&lt;x&gt;</b>',
    expected: '<b>[redacted]</b>',
  },
  {
    name: 'an ordinary sentence with no secret in it is untouched',
    source: 'secret',
    value: PASSWORD,
    text: 'the password field is required',
    expected: 'the password field is required',
  },
  {
    name: 'the whole connect URL',
    source: 'url',
    value: CDP_URL,
    text: `401 for ${CDP_URL}`,
    expected: '401 for [redacted]',
  },
  {
    name: 'the token alone',
    source: 'url',
    value: CDP_URL,
    text: `bad token ${TOKEN}`,
    expected: 'bad token [redacted]',
  },
  {
    name: 'the browser id in the path, alone',
    source: 'url',
    value: CDP_URL,
    text: `target ${BROWSER_ID} closed`,
    expected: 'target [redacted] closed',
  },
  {
    name: 'a short value under a credential-named key',
    source: 'url',
    value: CDP_URL,
    text: 'key k3y9 rejected',
    expected: 'key [redacted] rejected',
  },
  {
    name: 'ordinary query words stay readable in a page',
    source: 'url',
    value: CDP_URL,
    text: '<p>stealth is true; residential proxy; region eu; devtools browser</p>',
    expected: '<p>stealth is true; residential proxy; region eu; devtools browser</p>',
  },
  {
    name: 'a proxy exit password, and not its username',
    source: 'url',
    value: 'http://zone-res:pr0xy-p4ssw0rd@exit-7.test:8080',
    text: 'zone-res said pr0xy-p4ssw0rd',
    expected: 'zone-res said [redacted]',
  },
];

const redactedBy = (row: Row): string => {
  if (row.source === 'secret') {
    const bag = createSecretBag(['PASSWORD'], () => row.value);
    return redactSecrets(row.text, bag);
  }
  const bag = createSecretBag([]);
  for (const value of urlSecretValues(row.value)) bag.conceal(value);
  return redactSecrets(row.text, bag);
};

describe('unit · by-value redaction, one fixture table', () => {
  for (const row of ROWS) {
    test(`${row.source}: ${row.name}`, () => {
      expect(redactedBy(row)).toBe(row.expected);
    });
  }

  test('a value learned mid-run is caught in its encoded spellings too', () => {
    const bag = createSecretBag([]);
    bag.conceal('an swer/42');
    expect(redactSecrets('?a=an%20swer%2F42 and a=an+swer%2F42', bag)).toBe(
      '?a=[redacted] and a=[redacted]',
    );
  });

  test('the floor holds for every spelling: a short secret is not redacted, encoded or not', () => {
    const bag = createSecretBag(['PIN'], () => 'a b');
    expect(redactSecrets('a b and a%20b and a+b', bag)).toBe('a b and a%20b and a+b');
  });
});
