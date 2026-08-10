// Single source of truth for the framework version — read from package.json at build time.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageJson {
  version: string;
}

function loadVersion(): string {
  const packageJsonPath = resolve(__dirname, '../../..', 'package.json');
  const content = readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(content) as PackageJson;
  return pkg.version;
}

export const FRAMEWORK_VERSION = loadVersion();
