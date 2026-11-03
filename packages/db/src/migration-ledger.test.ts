// The checksum a ledger row pins an applied migration with: one value per migration whatever the
// checkout's line endings, and the value every LF migration already applied was recorded under.

import { describe, expect, test } from 'bun:test';
import { auditLedger, checksumOf, migrationChecksum } from './migration-ledger';

const LF = 'create table posts (\n  id text primary key\n);\n';

describe('unit · migration checksum', () => {
  test('an LF migration hashes to the value already in every ledger', () => {
    // Golden, computed before line endings were normalised: a database migrated from a Linux
    // checkout holds exactly this, so a change here refuses every deployed app's next migrate.
    expect(checksumOf(LF)).toBe('b76ad90096f60762e3f13f48a50a5aa1');
  });

  test('CRLF and LF produce one checksum', () => {
    // A Windows checkout under `core.autocrlf=true` reads the same file as CRLF; an image built
    // from it must not call a database a Linux image migrated "edited".
    const crlf = LF.replaceAll('\n', '\r\n');
    expect(checksumOf(crlf)).toBe(checksumOf(LF));
    expect(migrationChecksum({ id: 'a', name: 'a', up: crlf, down: '' })).toBe(checksumOf(LF));
  });

  test('a lone carriage return is content, not a line ending', () => {
    // Only the CRLF pair is a checkout artifact; a bare `\r` inside a string literal is SQL.
    expect(checksumOf("select 'a\rb';")).not.toBe(checksumOf("select 'a\nb';"));
  });

  test('a recorded checksum wins over the computed one', () => {
    expect(migrationChecksum({ id: 'a', name: 'a', up: LF, down: '', checksum: 'pinned' })).toBe(
      'pinned',
    );
  });
});

describe('unit · an edited migration', () => {
  const row = (id: string) => ({ id, checksum: 'applied', applied_at: '', app_version: 'dev' });
  const refusal = (id: string): { code?: string; fix?: string } => {
    const up = 'create table a (id int);';
    try {
      auditLedger([row(id)] as never, [{ id, name: 'a', up, down: '' }], 'dev');
    } catch (error) {
      return error as { code?: string; fix?: string };
    }
    return expect.unreachable('an edited migration must be refused');
  };

  // `x db gen "fix initial"` exited 0 and wrote the edit into the dump: the fix made it worse.
  test('the fix restores the file, and only then names a new migration', () => {
    const { code, fix } = refusal('0001_init');
    expect(code).toBe('X_MIGRATION_CONFLICT');
    expect(fix).toStartWith('git checkout -- packages/db/migrations/0001_init.sql   # ');
    expect(fix).toContain('never edit an applied migration');
    expect((fix ?? '').split('#')[0]).not.toContain('x db gen');
  });

  test('an id the shell would read restores the directory instead of splicing it', () => {
    const { fix } = refusal('0001_$(id)');
    expect(fix).toStartWith('git checkout -- packages/db/migrations   # ');
    expect(fix).not.toContain('$(id)');
  });
});
