// A built-in guard's module on disk, so the gate can `import()` the installed framework's rule. Its
// own file, apart from `guards-built-in.ts`, because it reads the guard TEMPLATES — which the
// serving roles' graph never may, and that file is read by the manifest projection on it.

// why: Bun ships no rename and no path joiner; the module is written then renamed so a concurrent
// gate run never imports half a file.
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { shippedGuardSource } from './templates/scaffold-guards';

/**
 * The built-in's module, under the app's ignored `.x/cache/` (never a shared temp dir, where
 * another user could plant the file first), named by its text's hash: a newer install is a new
 * path, so a long-lived process never imports a stale copy from its module cache.
 */
export async function materializeGuard(root: string, name: string): Promise<string> {
  const source = shippedGuardSource(name) ?? '';
  const path = join(root, '.x', 'cache', 'guards', `${name}-${Bun.hash(source).toString(36)}.ts`);
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === source) return path;
  const temp = `${path}.${String(process.pid)}.tmp`;
  await Bun.write(temp, source);
  await rename(temp, path);
  return path;
}
