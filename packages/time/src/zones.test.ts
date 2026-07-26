import { describe, expect, test } from 'bun:test';
import { fromIso } from './instant';
import { isValidTimeZone, observesDst, offsetAt, offsetLabel, zoneAbbrev } from './zones';

const winter = fromIso('2026-01-15T12:00:00Z');
const summer = fromIso('2026-07-15T12:00:00Z');

describe('offsetAt', () => {
  test('tracks DST per instant, in minutes east of UTC', () => {
    expect(offsetAt('Europe/Berlin', winter)).toBe(60);
    expect(offsetAt('Europe/Berlin', summer)).toBe(120);
    expect(offsetAt('America/New_York', winter)).toBe(-300);
    expect(offsetAt('America/New_York', summer)).toBe(-240);
    expect(offsetAt('UTC', summer)).toBe(0);
  });

  test('handles non-hour offsets', () => {
    expect(offsetAt('Asia/Kathmandu', summer)).toBe(345); // +05:45
    expect(offsetAt('Asia/Kolkata', summer)).toBe(330); // +05:30
    expect(offsetAt('Pacific/Chatham', winter)).toBe(825); // +13:45
  });

  test('a zone without DST reports one offset all year', () => {
    expect(offsetAt('Asia/Tokyo', winter)).toBe(offsetAt('Asia/Tokyo', summer));
    expect(observesDst('Asia/Tokyo', winter)).toBe(false);
    expect(observesDst('Europe/Berlin', winter)).toBe(true);
  });
});

describe('offsetLabel', () => {
  test('renders ISO-style offsets', () => {
    expect(offsetLabel(0)).toBe('Z');
    expect(offsetLabel(60)).toBe('+01:00');
    expect(offsetLabel(345)).toBe('+05:45');
    expect(offsetLabel(-240)).toBe('-04:00');
    expect(offsetLabel(-330)).toBe('-05:30');
  });
});

describe('isValidTimeZone', () => {
  test('accepts IANA names and rejects abbreviations and offsets', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    // Abbreviations are ambiguous (CST is three different zones) and are rejected.
    expect(isValidTimeZone('CET')).toBe(false);
    expect(isValidTimeZone('EST5EDT')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+01:00')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('zoneAbbrev', () => {
  test('labels the zone for the user', () => {
    expect(zoneAbbrev('Europe/Berlin', summer, 'en-US', 'shortOffset')).toBe('GMT+2');
    expect(zoneAbbrev('Asia/Kathmandu', summer, 'en-US', 'shortOffset')).toBe('GMT+5:45');
  });
});
