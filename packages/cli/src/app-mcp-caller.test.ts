// The address the app's MCP endpoint is told — which is what the scaffold's development token is
// gated on (`peerAddressClass(address) === 'loopback'`). A relayed "127.0.0.1" must not pass it.

import { describe, expect, test } from 'bun:test';
import { mcpCallerAddress } from './app-mcp';

const ctx = (ip: string | null, headers: Record<string, string> = {}) =>
  [ip, new Headers(headers)] as const;

describe('unit · the MCP endpoint is told a loopback caller only when it is one', () => {
  test('a direct loopback caller and a LAN caller are told as they are', () => {
    expect(mcpCallerAddress(...ctx('127.0.0.1'))).toBe('127.0.0.1');
    expect(mcpCallerAddress(...ctx('192.168.1.50'))).toBe('192.168.1.50');
    expect(mcpCallerAddress(...ctx(null))).toBeNull();
  });

  test('a LAN socket that forged x-forwarded-for: 127.0.0.1 past a declared hop is not loopback', () => {
    // `ctx.ip` is already the forwarded entry: that is what one trusted hop resolves.
    expect(mcpCallerAddress(...ctx('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe('::');
  });

  test('a tunnel on this machine relaying the internet is not loopback', () => {
    expect(mcpCallerAddress(...ctx('127.0.0.1', { forwarded: 'for=203.0.113.9' }))).toBe('::');
    expect(mcpCallerAddress(...ctx('::1', { 'x-real-ip': '203.0.113.9' }))).toBe('::');
  });

  test('a trusted proxy naming a remote caller keeps that address, for the failure meter', () => {
    expect(mcpCallerAddress(...ctx('203.0.113.9', { 'x-forwarded-for': '203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
  });
});
