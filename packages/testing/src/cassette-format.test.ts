// A cassette is committed and re-recorded, so its bytes are pinned exactly: a re-recording of the
// same answers must diff empty, whatever order the recorder built each object's keys in.

import { describe, expect, test } from 'bun:test';
import {
  CASSETTE_VERSION,
  type CassetteFile,
  parseCassette,
  serializeCassette,
} from './cassette-format';

const file: CassetteFile = {
  version: CASSETTE_VERSION,
  entries: [
    {
      url: 'https://api.example/v1?b=2',
      status: 200,
      method: 'GET',
      headers: { 'retry-after': '1', 'content-type': 'application/json' },
      encoding: 'utf8',
      body: '{"z":1,"a":2}',
    },
  ],
};

describe('serializeCassette', () => {
  test('sorts keys at every depth, indents two spaces and ends with one newline', async () => {
    expect(await serializeCassette(file)).toBe(
      [
        '{',
        '  "entries": [',
        '    {',
        '      "body": "{\\"z\\":1,\\"a\\":2}",',
        '      "encoding": "utf8",',
        '      "headers": {',
        '        "content-type": "application/json",',
        '        "retry-after": "1"',
        '      },',
        '      "method": "GET",',
        '      "status": 200,',
        '      "url": "https://api.example/v1?b=2"',
        '    }',
        '  ],',
        `  "version": ${CASSETTE_VERSION}`,
        '}',
        '',
      ].join('\n'),
    );
  });

  test("an empty cassette keeps JSON.stringify's empty-array spelling", async () => {
    expect(await serializeCassette({ version: CASSETTE_VERSION, entries: [] })).toBe(
      `{\n  "entries": [],\n  "version": ${CASSETTE_VERSION}\n}\n`,
    );
  });

  test('reads back as the file it wrote', async () => {
    expect(parseCassette(await serializeCassette(file), 'c.json')).toEqual(file);
  });
});
