import { describe, expect, test } from 'bun:test';
import { isReleasedKitForm, KIT_FORM_NAME, kitFormHash } from './app-kit-forms';

describe('unit · kit released forms', () => {
  test('the hash is the same for any app name the text spells', () => {
    const template = (name: string): string => `tools: mcp__${name}__*\nYou decide in ${name}.\n`;
    expect(kitFormHash(template('blog'), 'blog')).toBe(kitFormHash(template(KIT_FORM_NAME), ''));
    expect(kitFormHash(template('shop'), 'shop')).toBe(kitFormHash(template('blog'), 'blog'));
  });

  test('CRLF does not change the identity', () => {
    expect(kitFormHash('a\r\nb', 'x')).toBe(kitFormHash('a\nb', 'x'));
  });

  test('an edited text is no released form', () => {
    const known = [kitFormHash('mcp__blog__*', 'blog')];
    expect(isReleasedKitForm('mcp__blog__* edited', ['blog'], known)).toBe(false);
    expect(isReleasedKitForm('mcp__blog__*', ['blog'], known)).toBe(true);
    expect(isReleasedKitForm('mcp__blog__*', ['other', 'blog'], known)).toBe(true);
    expect(isReleasedKitForm('mcp__blog__*', ['blog'], undefined)).toBe(false);
  });
});
