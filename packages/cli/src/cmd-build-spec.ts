// `x build`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-build.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const buildSpec: CommandSpec = {
  name: 'build',
  summary: 'build a container image, a single binary, or a prerendered static site',
  usage: 'x build --target docker|binary|static [--tag name] [--out path] [--json]',
  requiresApp: true,
  flags: [
    { name: 'target', type: 'string', summary: 'docker | binary | static', default: 'docker' },
    { name: 'tag', type: 'string', summary: 'image tag (docker target)' },
    { name: 'out', type: 'string', summary: 'output path (binary and static targets)' },
  ],
};
