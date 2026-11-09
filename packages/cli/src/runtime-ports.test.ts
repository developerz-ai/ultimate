// The one install loop: a port whose install rejects part-way must not strand the ports installed
// before it — each is released, newest first, and the rejection is the one the caller sees.

import { describe, expect, test } from 'bun:test';
import type { AuditSink } from '@ultimat3/core';
import {
  frozenClock,
  getAuditSink,
  isUltimateError,
  resetAuditSink,
  setAuditSink,
  UltimateError,
} from '@ultimat3/core';
import type { SecretSource } from '@ultimat3/core/adapter';
import { PORT_BINDINGS } from './runtime-port-bindings';
import type { PortBindings } from './runtime-ports';
import { installPorts } from './runtime-ports';

const source: SecretSource = { name: 'fake', masterKey: () => undefined };

describe('unit · installPorts', () => {
  test('a rejecting install releases every port already installed, newest first, and rethrows', async () => {
    const log: string[] = [];
    const bindings: Partial<PortBindings> = {
      clock: {
        phase: 'boot',
        install: () => {
          log.push('install clock');
          return () => {
            log.push('release clock');
          };
        },
      },
      secretSource: {
        phase: 'boot',
        install: async () => {
          throw new UltimateError({
            code: 'X_INVARIANT',
            cause: 'the adapter module would not load',
            fix: 'bun install',
          });
        },
      },
    };
    const failure = await installPorts(bindings, 'boot', {
      clock: frozenClock(0),
      secretSource: source,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUltimateError(failure) ? failure.cause : String(failure)).toBe(
      'the adapter module would not load',
    );
    expect(log).toEqual(['install clock', 'release clock']);
  });

  test('the auditSink release restores the sink it found, not the empty default', async () => {
    const found: AuditSink = { write: () => undefined };
    const mine: AuditSink = { write: () => undefined };
    setAuditSink(found);
    try {
      const [release] = await installPorts(PORT_BINDINGS, 'services', { auditSink: mine });
      expect(getAuditSink()).toBe(mine);
      await release?.();
      expect(getAuditSink()).toBe(found);
    } finally {
      resetAuditSink();
    }
  });
});
