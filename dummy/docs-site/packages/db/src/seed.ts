// Deterministic fixtures, run by `x db seed`. No entity is declared yet, so there is nothing
// to insert — the shape stays so the first `x g entity` has one obvious place to seed from.
//
// `x db seed` discovers every exported `defineSeed()` in a package's `src/seed*.ts` and opens
// the database the way `x db migrate` does, embedded PGlite included. Never a plain `bun run`
// script: that needs a `postgres:` `DATABASE_URL` and cannot see the embedded database.
import { defineSeed } from '@ultimat3/entity';

export const docsSiteSeed = defineSeed('docs-site', async () => {
  // `await insert(<entity>, [...])` once an entity exists.
});
