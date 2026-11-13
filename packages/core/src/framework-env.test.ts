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

  // An adapter's settings and credentials are how an app configures it: declaring S3_BUCKET is the
  // point, and the rename a `switch` finding names would turn object storage (or mail, or the CDN
  // purge) off. Only a name no app configures the framework by is a switch.
  test('adapter settings and credentials are the contract; the OTel signal family is a switch', () => {
    for (const name of ['S3_BUCKET', 'S3_SECRET_ACCESS_KEY', 'SMTP_URL', 'CLOUDFLARE_API_TOKEN']) {
      expect(frameworkEnvEntry(name)?.use).toBe('contract');
    }
    expect(frameworkEnvEntry('DATABASE_URL')?.use).toBe('contract');
    expect(frameworkEnvEntry('PORT')?.use).toBe('contract');
    expect(frameworkEnvEntry('OTEL_TRACES_EXPORTER')).toMatchObject({
      prefix: true,
      use: 'switch',
    });
  });
});
