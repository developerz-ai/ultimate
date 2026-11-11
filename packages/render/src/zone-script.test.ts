// The zone script: one cookie write from the browser's own zone, small enough to inline on every
// `app/` document, and run here against a stand-in `document` so the cookie it writes is the one
// `@ultimat3/http` reads.

import { describe, expect, test } from 'bun:test';
import { readCookie } from '@ultimat3/core';
import { DEFAULT_TZ_CONFIG } from '@ultimat3/http';
import { renderHead } from './head';
import {
  DETECTED_ZONE_COOKIE,
  ZONE_SCRIPT_MAX_BYTES,
  zoneScript,
  zoneScriptBody,
} from './zone-script';

/** Runs the body with `document.cookie` captured and the zone `Intl` answers stubbed. */
function written(zone: string): string {
  let cookie = '';
  const document = {
    set cookie(value: string) {
      cookie = value;
    },
  };
  const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: zone }) }) };
  new Function('document', 'Intl', zoneScriptBody())(document, intl);
  return cookie;
}

describe('zoneScript', () => {
  test('exports the exact detected cookie definition its generated body writes', () => {
    const cookie = written('Pacific/Auckland');
    const [pair = ''] = cookie.split(';');
    expect(DETECTED_ZONE_COOKIE).toBe(DEFAULT_TZ_CONFIG.detectedCookie);
    expect(readCookie(pair, DETECTED_ZONE_COOKIE)).toBe('Pacific/Auckland');
  });

  test("writes the browser's zone to the cookie the request pipeline reads as `detected`", () => {
    const cookie = written('America/Argentina/Buenos_Aires');
    const [pair = ''] = cookie.split(';');
    expect(readCookie(pair, DEFAULT_TZ_CONFIG.detectedCookie)).toBe(
      'America/Argentina/Buenos_Aires',
    );
    // Site-wide and lasting: every `app/` page reads it, and a returning visitor's first paint too.
    expect(cookie).toContain('; Path=/');
    expect(cookie).toContain('; SameSite=Lax');
    expect(cookie).toMatch(/; Max-Age=\d+/);
    // A script cannot write an HttpOnly cookie: one in the attributes and the browser drops it.
    expect(cookie.toLowerCase()).not.toContain('httponly');
  });

  test('never writes the chosen cookie, so a guess cannot erase a pick', () => {
    expect(written('Asia/Kolkata').startsWith(`${DEFAULT_TZ_CONFIG.cookie}=`)).toBe(false);
  });

  test('a browser whose Intl throws writes nothing and throws nothing', () => {
    const document = { cookie: '' };
    // No `DateTimeFormat` at all: calling it throws the engine's own TypeError inside the script.
    const intl = {};
    new Function('document', 'Intl', zoneScriptBody())(document, intl);
    expect(document.cookie).toBe('');
  });

  test('is one small inline script, under its byte cap', () => {
    const bytes = new TextEncoder().encode(zoneScriptBody()).byteLength;
    expect(bytes).toBeLessThanOrEqual(ZONE_SCRIPT_MAX_BYTES);
    expect(ZONE_SCRIPT_MAX_BYTES).toBe(200);
    expect(renderHead([zoneScript()])).toBe(`<script>${zoneScriptBody()}</script>`);
    expect(zoneScript().key).toBe('script:zone');
  });
});
