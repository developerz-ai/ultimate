import { describe, expect, test } from 'bun:test';
import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import { chooseMechanism, md5Password, SCRAM_SHA_256, scramNonce, scramSession } from './pg-auth';
import type { Rng } from './thundering-herd';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A tiny deterministic LCG — enough to prove `scramNonce` is a pure function of its `Rng`. */
function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

// The client nonce, server-first-message, salt and iteration count below are copied verbatim
// from the RFC 7677 §3 worked example (user "user", password "pencil"). Its own printed
// client-final and server-final, however, were derived from a client-first-message-bare of
// `n=user,r=...` — the RFC's example fills in the username. Postgres's SCRAM never does that
// (`clientFirst()` always sends an empty `n=`, per this module's contract and RFC 5802 §5.1's
// allowance for the server to already know the identity), which changes the AuthMessage and
// therefore every value downstream of it. The proof and signature below are this algorithm run
// against the RFC's own inputs with `n=` empty — cross-checked two ways: once inside this module,
// once in a standalone WebCrypto reimplementation outside it — and NOT the values printed in the
// RFC text, which answer a different question (a client that does send its username).
describe('scramSession — RFC 5802 / RFC 7677 vector, adapted to an empty n=', () => {
  const clientNonce = 'rOprNGfwEbeRWgbNEkqO';
  const serverFirst =
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
  const serverFinal = 'v=3HO6Qt1M4MKJrmlKaoOqLAI0/0TV0HZe7J9H3MBtSOg=';
  const expectedClientFinal =
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,' +
    'p=qvT2SWdEH5Q06albL+hjSYuUhCG7VndFyzIb7CK4n9k=';

  test('clientFirst carries an empty n= and the mechanism is SCRAM-SHA-256', () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    expect(session.mechanism).toBe(SCRAM_SHA_256);
    expect(decoder.decode(session.clientFirst())).toBe(`n,,n=,r=${clientNonce}`);
  });

  test('clientFinal computes the exact proof the RFC vector requires', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    session.clientFirst();
    const final = await session.clientFinal(encoder.encode(serverFirst));
    expect(decoder.decode(final)).toBe(expectedClientFinal);
  });

  test('verify resolves once the server proves it knows the password', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    await session.clientFinal(encoder.encode(serverFirst));
    await expect(session.verify(encoder.encode(serverFinal))).resolves.toBeUndefined();
  });
});

describe('scramSession — hard failures', () => {
  const clientNonce = 'rOprNGfwEbeRWgbNEkqO';
  const serverFirst =
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';

  test('a server nonce that does not extend the client nonce is refused — the MITM check', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    const spoofed = 'r=totallyDifferentNonce,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
    await expect(session.clientFinal(encoder.encode(spoofed))).rejects.toThrow(
      ReplicationProtocolError,
    );
  });

  test('a wrong v= in server-final is refused with X_REPLICATION_FAILED', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    await session.clientFinal(encoder.encode(serverFirst));
    // 32 zero bytes is valid base64 of the right shape and, short of a cosmic coincidence,
    // never the real ServerSignature — so this exercises the mismatch branch, not the parse one.
    const zeroSignature = btoa(String.fromCharCode(...new Uint8Array(32)));
    await expect(session.verify(encoder.encode(`v=${zeroSignature}`))).rejects.toThrow(
      ReplicationFailedError,
    );
  });

  test('an e= error attribute in server-final is refused with X_REPLICATION_FAILED', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    await session.clientFinal(encoder.encode(serverFirst));
    await expect(session.verify(encoder.encode('e=invalid-proof'))).rejects.toThrow(
      ReplicationFailedError,
    );
  });

  test('verify before clientFinal is refused', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    await expect(session.verify(encoder.encode('v=AAAA'))).rejects.toThrow(
      ReplicationProtocolError,
    );
  });

  test('a second clientFinal is refused — a SASL session is single-use', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    await session.clientFinal(encoder.encode(serverFirst));
    await expect(session.clientFinal(encoder.encode(serverFirst))).rejects.toThrow(
      ReplicationProtocolError,
    );
  });

  test('a server-first missing s= is refused', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    const bad = `r=${clientNonce}xyz,i=4096`;
    await expect(session.clientFinal(encoder.encode(bad))).rejects.toThrow(
      ReplicationProtocolError,
    );
  });

  test('a server-first with a non-numeric i= is refused', async () => {
    const session = scramSession({ password: 'pencil', nonce: clientNonce });
    const bad = `r=${clientNonce}xyz,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=four-thousand`;
    await expect(session.clientFinal(encoder.encode(bad))).rejects.toThrow(
      ReplicationProtocolError,
    );
  });
});

describe('scramNonce', () => {
  test('is deterministic under a seeded rng and differs across seeds', () => {
    const a1 = scramNonce(seededRng(1));
    const a2 = scramNonce(seededRng(1));
    const b = scramNonce(seededRng(2));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  test('never contains the attribute separator, whatever the seed', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      expect(scramNonce(seededRng(seed))).not.toContain(',');
    }
  });
});

describe('md5Password', () => {
  // Hand-computed with `Bun.CryptoHasher` directly (not this module) in a scratch script:
  //   inner = md5hex('correct horse battery staple' + 'repluser')
  //         = 'd64ed0d5224ca744b85aafb006979c0c'
  //   outer = md5hex(inner + bytes[0x9a, 0x3c, 0x1e, 0x77]) = 'a32abd4a55584265300fd3c2c554f582'
  //   result = 'md5' + outer
  test('matches an independently hand-computed vector', () => {
    const result = md5Password({
      user: 'repluser',
      password: 'correct horse battery staple',
      salt: new Uint8Array([0x9a, 0x3c, 0x1e, 0x77]),
    });
    expect(result).toBe('md5a32abd4a55584265300fd3c2c554f582');
  });

  test('changing the salt changes the answer', () => {
    const base = { user: 'repluser', password: 'correct horse battery staple' };
    const a = md5Password({ ...base, salt: new Uint8Array([0x01, 0x02, 0x03, 0x04]) });
    const b = md5Password({ ...base, salt: new Uint8Array([0x05, 0x06, 0x07, 0x08]) });
    expect(a).not.toBe(b);
    expect(a.startsWith('md5')).toBe(true);
  });
});

describe('chooseMechanism', () => {
  test('picks SCRAM-SHA-256 when the server offers it', () => {
    expect(chooseMechanism(['SCRAM-SHA-256', 'SCRAM-SHA-256-PLUS'])).toBe(SCRAM_SHA_256);
  });

  test('refuses a list containing only SCRAM-SHA-256-PLUS — no channel binding here', () => {
    expect(() => chooseMechanism(['SCRAM-SHA-256-PLUS'])).toThrow(ReplicationProtocolError);
  });

  test('refuses an empty list', () => {
    expect(() => chooseMechanism([])).toThrow(ReplicationProtocolError);
  });
});
