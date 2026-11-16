// The database one upgrade fixture runs against. With a test server (`TEST_DATABASE_URL`, the
// gate's own) each fixture creates a fresh `x_upgrade_fixture_<version>_<hex>` there and drops it
// after: the shared database is dirty from the gate's suites, and fixture N met fixture N-1's
// ledger. With none, the scaffold's embedded default stands and nothing is sent.

import { renderThrowable } from '@ultimat3/core';

type Env = Readonly<Record<string, string>>;

/** One admin statement on the test server's maintenance connection. */
export type AdminStatement = (statement: string) => Promise<void>;

export type FixtureDatabase =
  | { readonly env: Env; readonly close: () => Promise<void> }
  | { readonly refused: string };

const PREFIX = 'x_upgrade_fixture_';
const IDENTIFIER_MAX = 63;

/** `x_upgrade_fixture_<version, [a-z0-9_] only>_<8 hex>`, cut to Postgres' identifier length. */
export function fixtureDatabaseName(version: string, random: string): string {
  const hex = random
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
    .slice(0, 8);
  const suffix = `_${hex}`;
  const slug = version.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${`${PREFIX}${slug}`.slice(0, IDENTIFIER_MAX - suffix.length)}${suffix}`;
}

const serverAdmin =
  (url: string): AdminStatement =>
  async (statement) => {
    const sql = new Bun.SQL(url, { max: 1 });
    try {
      await sql.unsafe(statement);
    } finally {
      await sql.end();
    }
  };

/**
 * Create the fixture's database and hand back the env that points at it. `create database` is the
 * collision refusal (`42P04`): a name that exists is never adopted, and never dropped — `close`
 * drops only what this call created. A drop that fails is said on stderr, never thrown over the
 * fixture's own outcome.
 */
export async function openFixtureDatabase(
  env: Env,
  version: string,
  admin?: AdminStatement,
): Promise<FixtureDatabase> {
  const server = env['TEST_DATABASE_URL'];
  if (server === undefined) return { env, close: async () => {} };
  const send = admin ?? serverAdmin(server);
  const name = fixtureDatabaseName(version, crypto.randomUUID());
  try {
    await send(`create database "${name}"`);
  } catch (error) {
    return { refused: `could not create the fixture database ${name}: ${renderThrowable(error)}` };
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  return {
    env: { ...env, DATABASE_URL: url.href },
    close: async () => {
      try {
        await send(`drop database if exists "${name}" with (force)`);
      } catch (error) {
        process.stderr.write(
          `upgrade-fixtures: ${name} was not dropped (${renderThrowable(error)}); drop it by hand: psql "$TEST_DATABASE_URL" -c 'drop database "${name}" with (force)'\n`,
        );
      }
    },
  };
}
