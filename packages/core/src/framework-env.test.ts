import { describe, expect, test } from 'bun:test';
import { FRAMEWORK_ENV, frameworkEnvEntry } from './framework-env';

describe('unit · FRAMEWORK_ENV', () => {
  test('one entry per name: two owners for one name would be two answers to one question', () => {
    const names = FRAMEWORK_ENV.map((entry) => entry.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  test('an exact name beats the prefix it falls under', () => {
    expect(frameworkEnvEntry('ULTIMATE_CURSOR_SECRET')?.use).toBe('contract');
    expect(frameworkEnvEntry('ULTIMATE_SOMETHING_NEW')).toMatchObject({
      name: 'ULTIMATE_',
      prefix: true,
      use: 'internal',
    });
  });

  test('a name the framework does not read has no entry, prototype members included', () => {
    expect(frameworkEnvEntry('HCAPTCHA_SECRET')).toBeUndefined();
    expect(frameworkEnvEntry('constructor')).toBeUndefined();
    expect(frameworkEnvEntry('__proto__')).toBeUndefined();
  });

  // The adopter case this list exists for: an app's own Cloudflare token switched the CDN purge on.
  test('the CDN purge credentials are switches, the deploy contract is not', () => {
    expect(frameworkEnvEntry('CLOUDFLARE_API_TOKEN')).toMatchObject({
      owner: 'cache',
      use: 'switch',
    });
    expect(frameworkEnvEntry('DATABASE_URL')?.use).toBe('contract');
    expect(frameworkEnvEntry('PORT')?.use).toBe('contract');
  });
});
