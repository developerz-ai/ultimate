// The offline decision per port: a double only where `runtime.ts` supplied the port, never the
// app's own value, and only on a port the `services` loop installs — a double on any other phase
// would be a row that silently installs nothing.

import { describe, expect, test } from 'bun:test';
import type { AuditSink } from '@ultimat3/core/adapter';
import type { MailDriver } from '@ultimat3/mail/adapter';
import { OFFLINE_PORTS, offlineChosen } from './offline-ports';
import { PORT_BINDINGS } from './runtime-port-bindings';
import type { WiredPort } from './runtime-ports';

const appSink: AuditSink = { write: () => undefined };

describe('unit · offline ports', () => {
  test('a supplied auditSink is replaced by a memory double, never the app`s', () => {
    const chosen = offlineChosen({ auditSink: appSink });
    expect(chosen.auditSink).toBeDefined();
    expect(chosen.auditSink).not.toBe(appSink);
    expect(typeof (chosen.auditSink as { records?: unknown }).records).toBe('function');
  });

  test('an absent port stays absent: the refusal a real boot gives is kept', () => {
    expect(offlineChosen(undefined)).toEqual({});
    expect(offlineChosen({})).toEqual({});
  });

  test('a port decided `default` is never installed, even when supplied', () => {
    const mail = { name: 'resend' } as unknown as MailDriver;
    expect(offlineChosen({ mail })).toEqual({});
  });

  test('every double is a services-phase port, the one phase installOfflinePorts runs', () => {
    const doubles = (Object.keys(OFFLINE_PORTS) as WiredPort[]).filter(
      (port) => OFFLINE_PORTS[port].use === 'double',
    );
    expect(doubles).toEqual(['auditSink']);
    for (const port of doubles) expect(PORT_BINDINGS[port].phase).toBe('services');
  });
});
