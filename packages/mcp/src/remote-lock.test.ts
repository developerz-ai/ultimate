// `tools.lock.json`'s bytes are the review a person reads in a diff, so they are pinned exactly:
// keys sorted at every depth, two-space indent, one trailing newline — whatever writes them.

import { describe, expect, test } from 'bun:test';
import type { RemoteTool } from './remote-client';
import { lockChanges, readToolsLock, writeToolsLock } from './remote-lock';

const URL = 'https://docs.example/mcp';

const tool = (inputSchema: Readonly<Record<string, unknown>>): RemoteTool => ({
  name: 'search',
  description: 'search the docs',
  inputSchema,
  readOnlyHint: true,
});

const schema = { type: 'object', required: ['q'], properties: { q: { type: 'string' } } };
const reordered = { properties: { q: { type: 'string' } }, required: ['q'], type: 'object' };

describe('writeToolsLock', () => {
  test('writes sorted keys at every depth, indented, with one trailing newline', () => {
    const text = writeToolsLock(undefined, 'docs', URL, ['search'], [tool(schema)]);
    expect(text).toBe(
      [
        '{',
        '  "servers": {',
        '    "docs": {',
        '      "tools": {',
        '        "search": {',
        '          "description": "search the docs",',
        '          "inputSchema": {',
        '            "properties": {',
        '              "q": {',
        '                "type": "string"',
        '              }',
        '            },',
        '            "required": [',
        '              "q"',
        '            ],',
        '            "type": "object"',
        '          },',
        '          "readOnly": false',
        '        }',
        '      },',
        `      "url": "${URL}"`,
        '    }',
        '  },',
        '  "version": 1',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('the same tools in another key order are the same bytes', () => {
    const a = writeToolsLock(undefined, 'docs', URL, ['search'], [tool(schema)]);
    const b = writeToolsLock(undefined, 'docs', URL, ['search'], [tool(reordered)]);
    expect(b).toBe(a);
  });
});

describe('lockChanges', () => {
  const locked = readToolsLock(
    JSON.parse(writeToolsLock(undefined, 'docs', URL, ['search'], [tool(schema)])),
  ).get('docs');

  test('a schema whose keys only moved is no change', () => {
    // Neither the order the lock was built in nor the sorted order the lock file reads back in.
    const moved = { required: ['q'], type: 'object', properties: { q: { type: 'string' } } };
    expect(lockChanges(locked, URL, ['search'], [tool(moved)])).toEqual([]);
  });

  test('a schema that changed a value is a change', () => {
    const widened = { ...schema, required: [] };
    expect(lockChanges(locked, URL, ['search'], [tool(widened)])).toEqual([
      '"search" changed its input schema',
    ]);
  });
});
