#!/usr/bin/env bun
// `bunx create-ultimate myapp`. Delegates to `x new` so there is exactly one scaffolder: a second
// copy of the templates is a second thing to keep in sync, and it would drift by the first release.

import { createApp } from './index';

const code = await createApp({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
});

process.exit(code);
