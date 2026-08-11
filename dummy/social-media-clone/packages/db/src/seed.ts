// Deterministic seed: same rows every time, so a test and a demo see the same database.
// No entity is declared yet, so there is nothing to insert — the shape stays, so the first
// `x g entity` has one obvious place to seed from.

export async function seed(): Promise<number> {
  return 0;
}

if (import.meta.main) {
  const count = await seed();
  // Bun's stdout, not process.stdout: one runtime, one API. Awaited because the write resolves
  // asynchronously, and this JSON line is the whole output of `bun run db:seed`.
  await Bun.stdout.write(`${JSON.stringify({ ok: true, seeded: count })}\n`);
}
