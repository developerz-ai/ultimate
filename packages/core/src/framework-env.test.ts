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

  // An app's compose file sets the count; only the supervisor writes a child's place.
  test('the process count is the contract, a child index is internal', () => {
    expect(frameworkEnvEntry('ULTIMATE_PROCESSES')).toMatchObject({
      owner: 'cli',
      use: 'contract',
    });
    expect(frameworkEnvEntry('ULTIMATE_CHILD')).toMatchObject({ owner: 'core', use: 'internal' });
    expect(frameworkEnvEntry('ULTIMATE_CHILD')?.prefix).toBeUndefined();
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

  // The OTel spec's two service-identity names: the boot reads them (`serve-boot-telemetry.ts`),
  // and a deploy sets them on purpose — the contract, never caught by the `OTEL_` switch prefix.
  test('the service identity names are the contract, read by the boot', () => {
    for (const name of ['OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES']) {
      expect(frameworkEnvEntry(name)).toEqual({ name, owner: 'cli', use: 'contract' });
    }
  });
});
