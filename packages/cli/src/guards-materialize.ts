// A built-in guard's module on disk, so the gate can `import()` the installed framework's rule. Its
// own file, apart from `guards-built-in.ts`, because it reads the guard TEMPLATES — which the
// serving roles' graph never may, and that file is read by the manifest projection on it.

// why: Bun ships no rename, no forced remove and no path joiner; the module is written then renamed
// so a concurrent gate run never imports half a file.
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { shippedGuardSource } from './templates/scaffold-guards';

/**
 * The built-in's module, under the app's ignored `.x/cache/` (never a shared temp dir, where
 * another user could plant the file first), named by its text's hash: a newer install is a new
 * path, so a long-lived process never imports a stale copy from its module cache. Written to a temp
 * file of its own per call — parallel calls in one process never share one — then renamed; the
 * temp is gone either way, and so is a module an older install wrote for the same guard.
 */
export async function materializeGuard(root: string, name: string): Promise<string> {
  const source = shippedGuardSource(name) ?? '';
  const dir = join(root, '.x', 'cache', 'guards');
  const file = `${name}-${Bun.hash(source).toString(36)}.ts`;
  const path = join(dir, file);
  const existing = Bun.file(path);
  if ((await existing.exists()) && (await existing.text()) === source) return path;
  const temp = `${path}.${String(process.pid)}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await Bun.write(temp, source);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  await removeStale(dir, name, file);
  return path;
}

/** `<name>-<hash>.ts` an older install wrote — never `file`, never another guard sharing a prefix. */
async function removeStale(dir: string, name: string, file: string): Promise<void> {
  const own = new RegExp(`^${name.replaceAll('-', '\\-')}-[0-9a-z]+\\.ts$`);
  for await (const entry of new Bun.Glob(`${name}-*.ts`).scan({ cwd: dir })) {
    if (entry !== file && own.test(entry)) await rm(join(dir, entry), { force: true });
  }
}
