// Version loader — reads from root package.json to avoid circular dependency with core at
// module initialization time. This is necessary because registry.ts imports all command modules
// before core has finished initializing, so we bypass core and read the package.json directly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageJson {
  version: string;
}

export function loadVersion(): string {
  const packageJsonPath = resolve(__dirname, '../../..', 'package.json');
  const content = readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(content) as PackageJson;
  return pkg.version;
}
