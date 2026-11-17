// The two transports of one s3 disk address ONE bucket host: the Bun client's virtual-hosted
// endpoint and the signed path's URL are built by the same `bucketHost`, across every endpoint
// shape — an endpoint already naming the bucket was prefixed twice by the signed path only.

import { describe, expect, test } from 'bun:test';
import { clientTarget } from './driver-s3-client';
import { s3ObjectUrl } from './driver-s3-signed';

const ENDPOINTS = [
  'https://acct.r2.example.com',
  'https://media.acct.r2.example.com',
  'https://media.acct.r2.example.com/',
  'http://media.localhost:9000',
  'http://localhost:9000',
  'https://acct.example.com/base',
  'https://mediabucket.example.com',
];

describe('s3 virtual-hosted addressing · one host for both transports', () => {
  test.each(ENDPOINTS)('%s', (endpoint) => {
    const options = { bucket: 'media', endpoint, forcePathStyle: false, env: {} };
    const client = new URL(String(clientTarget(options)['endpoint']));
    const signed = s3ObjectUrl(options, 'a/b.png');
    expect(signed.host).toBe(client.host);
    expect(signed.protocol).toBe(client.protocol);
    expect(signed.host.startsWith('media.')).toBe(true);
    expect(signed.host.startsWith('media.media.')).toBe(false);
    expect(signed.pathname).toBe('/a/b.png');
  });

  test('the R2 endpoint that already names the bucket is signed for as given', () => {
    const url = s3ObjectUrl(
      { bucket: 'media', endpoint: 'https://media.acct.r2.example.com', forcePathStyle: false },
      'a/b.png',
    );
    expect(url.href).toBe('https://media.acct.r2.example.com/a/b.png');
  });
});
