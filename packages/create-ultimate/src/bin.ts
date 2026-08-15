#!/usr/bin/env bun
// `bunx create-ultimate myapp`. Delegates to `x new` so there is exactly one scaffolder: a second
// copy of the templates is a second thing to keep in sync, and it would drift by the first release.

// `writeLine`, not `process.stdout.write`: paired with the `process.exit` below, that combination
// truncates at the 64KB pipe buffer — and `bunx create-ultimate app` into an EXISTING directory
// emits one conflict finding per scaffolded file, which is exactly the payload that grows.
import { writeLine } from '@ultimat3/cli';
import { createApp } from './index';

const code = await createApp({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  write: writeLine,
});

process.exit(code);
