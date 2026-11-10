// The transport suite over `NatsTransport` and a real JetStream-enabled nats-server
// (`TEST_NATS_URL`): the memory run proves the checks, this one proves the client and the KV bucket
// meet them on a real socket. Every check roots its subjects and keys in a fresh UUID, so a server
// shared with other suites and earlier runs is never mistaken for this one's traffic.

import { describe } from 'bun:test';
import { NatsTransport } from '@ultimat3/realtime/server';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';
import { transportConformance } from './transport-conformance';

const url = Bun.env['TEST_NATS_URL'] ?? '';

describe.skipIf(url === '')(testName('live', 'the NATS transport on a real nats-server'), () => {
  behavesLike(
    transportConformance,
    () => new NatsTransport({ url, bucket: 'xconformance', onError: () => undefined }),
  );
});
