// `signAwsRequest` proven against AWS's own known answers, never against itself: a signer checked
// only by its own round trip agrees with every bug it has. Two published sources, embedded verbatim:
//
// 1. The AWS SigV4 test suite — https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4
//    (each case's `context.json`, `request.txt`, `header-canonical-request.txt`, `header-signature.txt`).
// 2. S3's worked examples — https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
//    ("Examples: Signature Calculations"), the case where `x-amz-content-sha256` is signed and the path
//    is encoded ONCE.

import { describe, expect, test } from 'bun:test';
import { signAwsRequest, UNSIGNED_PAYLOAD } from './aws-sigv4';
import { frozenClock } from './clock';

/** Every aws-c-auth case signs with this context; only the request differs. */
const SUITE = {
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  service: 'service',
  clock: frozenClock('2015-08-30T12:36:00Z'),
} as const;

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SCOPE = 'AKIDEXAMPLE/20150830/us-east-1/service/aws4_request';

interface SuiteCase {
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly token?: string;
  /** The suite's raw request line cannot travel through a WHATWG URL, so these encode once. */
  readonly doubleEncodePath?: boolean;
  readonly contentSha256Header?: boolean;
  readonly canonicalRequest: string;
  readonly signature: string;
}

const cases: readonly SuiteCase[] = [
  {
    name: 'get-vanilla',
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    canonicalRequest: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  },
  {
    name: 'post-vanilla',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    canonicalRequest: `POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
  },
  {
    name: 'get-vanilla-query-order-key-case',
    method: 'GET',
    url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1',
    canonicalRequest: `GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
  },
  {
    name: 'get-vanilla-query-order-encoded',
    method: 'GET',
    url: 'https://example.amazonaws.com/?Param-3=Value3&Param=Value2&%E1%88%B4=Value1',
    canonicalRequest: `GET\n/\n%E1%88%B4=Value1&Param=Value2&Param-3=Value3\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: '371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac',
  },
  {
    name: 'get-vanilla-with-session-token',
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    token: '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267',
    canonicalRequest: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267\n\nhost;x-amz-date;x-amz-security-token\n${EMPTY_SHA256}`,
    signature: '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8',
  },
  {
    name: 'post-sts-header-before',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    token:
      'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==',
    canonicalRequest: `POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==\n\nhost;x-amz-date;x-amz-security-token\n${EMPTY_SHA256}`,
    signature: '85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead',
  },
  {
    name: 'get-header-value-trim',
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' },
    canonicalRequest: `GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:20150830T123600Z\n\nhost;my-header1;my-header2;x-amz-date\n${EMPTY_SHA256}`,
    signature: 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736',
  },
  {
    name: 'get-unreserved',
    method: 'GET',
    url: 'https://example.amazonaws.com/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    canonicalRequest: `GET\n/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f',
  },
  {
    name: 'get-utf8',
    method: 'GET',
    url: 'https://example.amazonaws.com/ሴ',
    doubleEncodePath: false,
    canonicalRequest: `GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85',
  },
  {
    name: 'get-space-unnormalized',
    method: 'GET',
    url: 'https://example.amazonaws.com/example space/',
    doubleEncodePath: false,
    canonicalRequest: `GET\n/example%20space/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    signature: '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741',
  },
  {
    name: 'post-x-www-form-urlencoded',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '13' },
    body: 'Param1=value1',
    contentSha256Header: true,
    canonicalRequest:
      'POST\n/\n\ncontent-length:13\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e\nx-amz-date:20150830T123600Z\n\ncontent-length;content-type;host;x-amz-content-sha256;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
    signature: 'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b',
  },
];

describe('signAwsRequest — the aws-c-auth SigV4 suite', () => {
  for (const c of cases) {
    test(c.name, async () => {
      const signed = await signAwsRequest({
        ...SUITE,
        method: c.method,
        url: c.url,
        ...(c.headers === undefined ? {} : { headers: c.headers }),
        ...(c.body === undefined ? {} : { payload: { body: c.body } }),
        ...(c.token === undefined
          ? {}
          : { credentials: { ...SUITE.credentials, sessionToken: c.token } }),
        ...(c.doubleEncodePath === undefined ? {} : { doubleEncodePath: c.doubleEncodePath }),
        ...(c.contentSha256Header === undefined
          ? {}
          : { contentSha256Header: c.contentSha256Header }),
      });
      expect(signed.canonicalRequest).toBe(c.canonicalRequest);
      expect(signed.signature).toBe(c.signature);
      const signedHeaders = c.canonicalRequest.split('\n').at(-2);
      expect(signed.headers['authorization']).toBe(
        `AWS4-HMAC-SHA256 Credential=${SCOPE}, SignedHeaders=${signedHeaders}, Signature=${c.signature}`,
      );
      expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
      if (c.token !== undefined) expect(signed.headers['x-amz-security-token']).toBe(c.token);
    });
  }
});

/** S3's published worked examples: its own credentials, its own instant, service `s3`. */
const S3 = {
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  service: 's3',
  clock: frozenClock('2013-05-24T00:00:00Z'),
} as const;
const S3_SCOPE = 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request';

describe('signAwsRequest — the S3 worked examples', () => {
  test('GET Object: x-amz-content-sha256 is signed by default for s3', async () => {
    const signed = await signAwsRequest({
      ...S3,
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { Range: 'bytes=0-9' },
    });
    expect(signed.headers['authorization']).toBe(
      `AWS4-HMAC-SHA256 Credential=${S3_SCOPE}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
    );
    expect(signed.headers['x-amz-content-sha256']).toBe(EMPTY_SHA256);
  });

  test('PUT Object: a `$` in the key is encoded ONCE, and the body is hashed', async () => {
    const signed = await signAwsRequest({
      ...S3,
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payload: { body: new TextEncoder().encode('Welcome to Amazon S3.') },
    });
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(signed.headers['x-amz-content-sha256']).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    expect(signed.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
    // The URL to send is the one that was signed: the key's `$` travels encoded.
    expect(signed.url).toBe('https://examplebucket.s3.amazonaws.com/test%24file.text');
  });

  test('GET Bucket Lifecycle: a valueless query key is `key=`', async () => {
    const signed = await signAwsRequest({
      ...S3,
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/?lifecycle',
    });
    expect(signed.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(signed.signature).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  test('GET Bucket (List Objects): query pairs sorted by key', async () => {
    const signed = await signAwsRequest({
      ...S3,
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2',
    });
    expect(signed.signature).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });
});

describe('signAwsRequest — the payload and the rules around the vectors', () => {
  test('UNSIGNED-PAYLOAD is the literal in the canonical request and the header', async () => {
    const signed = await signAwsRequest({
      ...S3,
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/big.bin',
      payload: UNSIGNED_PAYLOAD,
    });
    expect(signed.canonicalRequest.endsWith('\nUNSIGNED-PAYLOAD')).toBe(true);
    expect(signed.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
  });

  test('a pre-computed hash is signed as given — a stream the caller already hashed', async () => {
    const hash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    const signed = await signAwsRequest({
      ...S3,
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payload: { sha256Hex: hash },
    });
    expect(signed.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  test('a non-s3 service signs no content hash header unless asked', async () => {
    const signed = await signAwsRequest({ ...SUITE, method: 'GET', url: 'https://a.example/' });
    expect(signed.headers['x-amz-content-sha256']).toBeUndefined();
  });

  test('a non-s3 path is encoded twice; an s3 path once', async () => {
    const url = 'https://example.amazonaws.com/a b';
    const twice = await signAwsRequest({ ...SUITE, method: 'GET', url });
    expect(twice.canonicalRequest.split('\n')[1]).toBe('/a%2520b');
    const once = await signAwsRequest({ ...S3, method: 'GET', url });
    expect(once.canonicalRequest.split('\n')[1]).toBe('/a%20b');
  });

  test("the bytes encodeURIComponent keeps but SigV4 does not — !'()* — are escaped", async () => {
    // A key like `report (1).pdf` is legal on every disk; signed with `(` raw, S3 answers 403.
    const signed = await signAwsRequest({
      ...S3,
      method: 'GET',
      url: "https://examplebucket.s3.amazonaws.com/a(1)!*'?q=(x)",
    });
    const [, path, query] = signed.canonicalRequest.split('\n');
    expect(path).toBe('/a%281%29%21%2A%27');
    expect(query).toBe('q=%28x%29');
  });

  test('a caller cannot pre-empt the date or the authorization', async () => {
    const signed = await signAwsRequest({
      ...SUITE,
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: { 'X-Amz-Date': '19990101T000000Z', Authorization: 'forged' },
    });
    expect(signed.signature).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  test('the instant is the clock’s, to the second', async () => {
    const signed = await signAwsRequest({
      ...SUITE,
      clock: frozenClock('2024-02-29T23:59:58.999Z'),
      method: 'GET',
      url: 'https://example.amazonaws.com/',
    });
    expect(signed.headers['x-amz-date']).toBe('20240229T235958Z');
    expect(signed.stringToSign.split('\n')[2]).toBe('20240229/us-east-1/service/aws4_request');
  });

  test.each([
    ['an empty access key id', { credentials: { accessKeyId: '', secretAccessKey: 's' } }],
    ['a region with a slash', { region: 'us/east' }],
    ['a lower-case method', { method: 'get' }],
    ['a malformed escape in the path', { url: 'https://example.amazonaws.com/%ZZ' }],
    ['a relative url', { url: '/just/a/path' }],
  ])('%s is a coded refusal, never a bare throw', async (_label, override) => {
    const input = { ...SUITE, method: 'GET', url: 'https://example.amazonaws.com/', ...override };
    await expect(signAwsRequest(input)).rejects.toBeUltimateError('X_INVARIANT');
  });
});
