// The one-home helper table, one row at a time: each row is matched on the SHAPE of a copy — the
// constants, the call, the replacement table — never on a name, because the copy that does the
// damage is never called what the original is. The real-tree half is `scripts/flight-copies.test.ts`.

import { describe, expect, test } from 'bun:test';
import { checkHelperHomes, HELPER_HOMES } from './helper-homes';

const at = 'packages/x/src/copy.ts';
const helpersIn = (text: string, path = at): readonly string[] =>
  checkHelperHomes({ at: path, text }).map((finding) => {
    expect(finding.code).toBe('X_HELPER_COPY');
    return /a second (\S+)/.exec(finding.cause)?.[1] ?? '';
  });

describe('a second implementation of a helper with one home is refused', () => {
  test('fnv1a, by its constants in any spelling, never by its name', () => {
    expect(helpersIn('let h = 0x811c9dc5; h = Math.imul(h ^ c, 0x01000193);')).toEqual(['fnv1a']);
    expect(helpersIn('const seed = 2166136261; const p = 16_777_619;')).toEqual(['fnv1a']);
    expect(helpersIn('const BASIS = 0x811C_9DC5;')).toEqual(['fnv1a']);
  });

  test('fingerprint, as a hasher fed canonicalJson', () => {
    const copy =
      "const h = new Bun.CryptoHasher('sha256');\nh.update(canonicalJson(body));\nreturn h.digest('hex').slice(0, 16);";
    expect(helpersIn(copy)).toEqual(['fingerprint']);
  });

  test('but a KEYED hasher over canonicalJson is an HMAC, keyedFingerprint, not a copy', () => {
    const hmac = "new Bun.CryptoHasher('sha256', key).update(canonicalJson(value)).digest('hex')";
    expect(helpersIn(hmac)).toEqual([]);
  });

  test('xxHash32, as a direct call', () => {
    expect(
      helpersIn("const etag = Bun.hash.xxHash32(bytes).toString(16).padStart(8, '0');"),
    ).toEqual(['contentHash']);
    // Inside a template literal's interpolation, where the masked view sees nothing.
    const interpolated = ['const etag = `"$', '{Bun.hash.xxHash32(bytes).toString(16)}"`;'];
    expect(helpersIn(interpolated.join(''))).toEqual(['contentHash']);
  });

  test('escapeHtml, as a table or a replace chain writing `&amp;`', () => {
    expect(helpersIn("const T = { '&': '&amp;', '<': '&lt;' };")).toEqual(['escapeHtml']);
    expect(helpersIn("v.replace(/&/g, '&amp;').replace(/</g, '&lt;');")).toEqual(['escapeHtml']);
    expect(helpersIn('v.replaceAll("&", "&amp;");')).toEqual(['escapeHtml']);
  });

  test('a DECODER of `&amp;` is not an escaper', () => {
    expect(helpersIn("html.replaceAll('&lt;', '<').replaceAll('&amp;', '&');")).toEqual([]);
  });

  test('readCookie, as a `;` split that percent-decodes', () => {
    const copy =
      "for (const part of header.split(';')) {\n  const i = part.indexOf('=');\n  return decodeURIComponent(part.slice(i + 1));\n}";
    expect(helpersIn(copy)).toEqual(['readCookie']);
  });

  test('readCookie, when the decode lives in a helper further down the file', () => {
    const copy =
      "for (const part of header.split(';')) {\n  const equals = part.indexOf('=');\n  if (equals < 0) continue;\n  return decode(part.slice(equals + 1));\n}";
    expect(helpersIn(copy)).toEqual(['readCookie']);
  });

  test('a `;` split that is not a name=value walk is not a cookie reader', () => {
    expect(helpersIn("const [type = ''] = contentType.split(';');")).toEqual([]);
    expect(helpersIn("for (const s of sql.split(';')) run(s.trim());")).toEqual([]);
  });

  test('PgExecutor, by name and by the shape of its one method', () => {
    expect(helpersIn('export interface PgExecutor {\n  query<R>(s: string): R;\n}')).toEqual([
      'PgExecutor',
    ]);
    const renamed =
      'interface Exec {\n  query<Row>(text: string, values: readonly unknown[]): Promise<readonly Row[]>;\n}';
    expect(helpersIn(renamed)).toEqual(['PgExecutor']);
  });

  test('an IMPLEMENTATION of the PgExecutor method is a fake, not a declaration', () => {
    const fake =
      'const e: PgExecutor = {\n  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {\n    return Promise.resolve([]);\n  },\n};';
    expect(helpersIn(fake)).toEqual([]);
  });

  test('storeMode, as an environment ternary — inside a scaffold template too', () => {
    expect(helpersIn("resolveEnvironment({ env }) === 'test' ? memoryDriver() : pg();")).toEqual([
      'storeMode',
    ]);
    expect(
      helpersIn("export const t = `x = resolveEnvironment({ env }) === 'test' ? a : b;`;"),
    ).toEqual(['storeMode']);
  });
});

describe('what is never a copy', () => {
  test('each helper in its own home', () => {
    const samples: Readonly<Record<string, string>> = {
      fnv1a: 'const B = 0x811c_9dc5;',
      fingerprint: "new Bun.CryptoHasher('sha256').update(canonicalJson(v))",
      contentHash: 'Bun.hash.xxHash32(input)',
      escapeHtml: "const T = { '&': '&amp;' };",
      readCookie: "header.split(';'); decodeURIComponent(raw);",
      PgExecutor: 'export interface PgExecutor {}',
      storeMode: "resolveEnvironment({ env }) === 'test' ? 'memory' : 'database'",
    };
    for (const rule of HELPER_HOMES) {
      expect(helpersIn(samples[rule.helper] ?? '', rule.home)).toEqual([]);
    }
  });

  test('a copy written inside a comment is prose', () => {
    expect(helpersIn('// was: let h = 0x811c9dc5;\n/* Bun.hash.xxHash32(x) */\n')).toEqual([]);
  });

  test('a call to the helper is its use, not a copy', () => {
    expect(
      helpersIn(
        "import { escapeHtml, readCookie, storeMode } from '@ultimat3/core';\nconst m = storeMode(Bun.env) === 'memory';\nreadCookie(h, 'x'); escapeHtml(v);",
      ),
    ).toEqual([]);
  });

  test('each finding names the file, the line and the import that replaces it', () => {
    const [finding] = checkHelperHomes({ at, text: '\n\nconst B = 0x811c9dc5;' });
    expect(finding?.cause).toContain(`${at}:3`);
    expect(finding?.fix).toContain("import { fnv1a } from '@ultimat3/core'");
    expect(finding?.at).toBe(at);
  });

  test('every home is a real file in this repository', async () => {
    for (const rule of HELPER_HOMES) expect(await Bun.file(rule.home).exists()).toBe(true);
  });
});
