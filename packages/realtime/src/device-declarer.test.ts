// The declaring file read off a stack: the first frame outside the internal files, by path
// alone — line and column drop, because an edit to the declaring module moves them.

import { describe, expect, test } from 'bun:test';
import { declarerFile, pickDeclarer } from './device-declarer';

const OWN = '/app/node_modules/@ultimat3/realtime/dist/device-socket.js';

describe('unit · pickDeclarer', () => {
  test('skips the internal frames and answers the caller file without line or column', () => {
    const stack = [
      'Error',
      `    at deviceSocket (${OWN}:215:29)`,
      '    at /app/apps/web/app/link.ts:4:14',
    ].join('\n');
    expect(pickDeclarer(stack, [OWN])).toBe('/app/apps/web/app/link.ts');
  });

  test('a named frame, and a Windows path compared with `/`', () => {
    const stack = [
      'Error',
      '    at deviceSocket (C:\\app\\realtime\\device-socket.ts:1:2)',
      '    at declare (C:\\app\\apps\\web\\link.ts:9:3)',
    ].join('\n');
    expect(pickDeclarer(stack, ['C:/app/realtime/device-socket.ts'])).toBe(
      'C:/app/apps/web/link.ts',
    );
  });

  test('no frame naming a file outside the internal ones is null', () => {
    expect(
      pickDeclarer(`Error\n    at deviceSocket (${OWN}:1:1)\n    at <anonymous> (native)`, [OWN]),
    ).toBeNull();
  });

  test('from a real call, the file that called', () => {
    expect(declarerFile([])).toBe(import.meta.path.replaceAll('\\', '/'));
  });
});
