// The barrel's own shape: what 25.0.0 took off it stays off. The SQL a caller outside this package
// runs is exported; the statements only this package executes are read from their own modules.
import { describe, expect, test } from 'bun:test';
import * as barrel from './index';
import { DEFAULT_MAX_RECIPIENTS } from './notifier';

describe('@ultimat3/notify public surface', () => {
  const names = Object.keys(barrel);

  test('the SQL another workspace reads, and none of the rest', () => {
    // The four tables are installed by the boot (`cli/src/framework-schema.ts`). MARK_READ went in
    // 25.0.0: its one reader was a live test, and a test is no reason to export a statement — the
    // composition test drives `postgresInboxStore().markRead()`. CLAIM and INBOX_PAGE had no reader.
    expect(names.filter((name) => name.startsWith('SQL_')).sort()).toEqual([
      'SQL_NOTIFY_DELIVERIES_TABLE',
      'SQL_NOTIFY_DIGESTS_TABLE',
      'SQL_NOTIFY_INBOX_TABLE',
      'SQL_PUSH_DEVICES_TABLE',
    ]);
  });

  test('a memory or Postgres store has ONE spelling, memoryX / postgresX', () => {
    expect(names.filter((name) => /^create(Memory|Pg|Postgres)[A-Z]|^pg[A-Z]/.test(name))).toEqual(
      [],
    );
    for (const name of [
      'memoryDeliveryLedger',
      'memoryDigestStore',
      'memoryInboxStore',
      'memoryPreferenceStore',
      'memoryPushDeviceStore',
      'postgresDeliveryLedger',
      'postgresDigestStore',
      'postgresInboxStore',
      'postgresPushDeviceStore',
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('the two native push bounds an app reads', () => {
    expect(barrel.PUSH_DEVICES_PER_ACTOR).toBe(20);
    expect(barrel.PUSH_BAD_TOKEN_LIMIT).toBe(3);
  });

  test('the fan-out chunk equals the default audience cap: a default notifier is one chunk', () => {
    expect(barrel.NOTIFY_CHUNK_SIZE).toBe(DEFAULT_MAX_RECIPIENTS);
  });

  test('v31: the app API only — no channel-name constant, env name, bound or internal guard', () => {
    const internal = [
      'APNS_KEY_ENV',
      'DATA_PUSH_MAX_KEYS',
      'DATA_PUSH_MAX_VALUE',
      'DEFAULT_INBOX_PAGE',
      'DEFAULT_MAX_RECIPIENTS',
      'DEFAULT_NATIVE_PUSH_DEADLINE_MS',
      'DELIVERY_STATUSES',
      'FCM_KEY_ENV',
      'IN_APP_CHANNEL',
      'MAIL_CHANNEL',
      'NOTIFY_ERROR_CODES',
      'PUSH_CHANNEL',
      'PUSH_PLATFORMS',
      'SMS_CHANNEL',
      'isBulkChannel',
      'isDeliveryStatus',
      'isSmsNumber',
      'recipientSchema',
    ];
    expect(internal.filter((name) => names.includes(name))).toEqual([]);
  });

  test('every error class an app matches with instanceof stays', () => {
    for (const name of [
      'NotifyChannelDuplicateError',
      'NotifyChannelsEmptyError',
      'NotifyDeliveryFailedError',
      'NotifyDigestUnsupportedError',
      'NotifyFanoutTooWideError',
      'NotifyPushDeviceGoneError',
      'NotifyPushMessageInvalidError',
      'NotifyPushProviderRefusedError',
      'NotifySmsNumberInvalidError',
      'NotifySmsTransportMissingError',
      'NotifyStoreMissingError',
    ]) {
      expect(names).toContain(name);
    }
  });
});
