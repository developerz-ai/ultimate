// `decodeHtmlEntities`: every numeric reference, the common named ones, one pass.

import { describe, expect, test } from 'bun:test';
import { escapeHtml } from '@ultimat3/core';
import { decodeHtmlEntities } from './html-entities';

describe('decodeHtmlEntities', () => {
  test('undoes the framework escaper for every character it escapes', () => {
    const typed = `Tom's "cat" & <dog>`;
    expect(decodeHtmlEntities(escapeHtml(typed))).toBe(typed);
  });

  test('decimal and hex references, either case of x', () => {
    expect(decodeHtmlEntities('&#39;&#x2019;&#X1F600;')).toBe("'’\u{1f600}");
  });

  test('128 to 159 read as windows-1252, as a browser renders them', () => {
    expect(decodeHtmlEntities('&#128; &#x80; &#150; &#x9F;')).toBe('€ € – Ÿ');
  });

  test('a numeric reference needs no semicolon, as a browser reads it', () => {
    expect(decodeHtmlEntities('Tom&#39s &#x41!')).toBe("Tom's A!");
  });

  test('named references from the table', () => {
    expect(decodeHtmlEntities('&nbsp;&mdash;&ldquo;&rdquo;&euro;')).toBe(' —“”€');
  });

  test('one pass: an escaped reference reads as the reference', () => {
    expect(decodeHtmlEntities('&amp;lt; &amp;#39;')).toBe('&lt; &#39;');
  });

  test('a name outside the table, or a non-legacy one with no semicolon, stays as written', () => {
    expect(decodeHtmlEntities('&bogus; &constructor; &#; &hellip &euro')).toBe(
      '&bogus; &constructor; &#; &hellip &euro',
    );
  });

  test('a legacy name needs no semicolon: the longest one it starts with, the rest kept', () => {
    expect(decodeHtmlEntities('&amp &lt &copy2026 &ampx')).toBe('& < ©2026 &x');
  });

  test('a null, a surrogate or a point past Unicode reads as U+FFFD', () => {
    expect(decodeHtmlEntities('&#0;&#xD800;&#1114112;')).toBe('���');
  });
});
