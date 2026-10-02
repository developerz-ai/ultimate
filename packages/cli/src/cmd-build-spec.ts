// `x build`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-build.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const buildSpec: CommandSpec = {
  name: 'build',
  summary:
    'build a container image, a single binary, a prerendered static site, or the store an image boots from',
  usage:
    'x build --target docker|binary|static|prebuilt [--tag name] [--out path] [--no-preflight] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'target',
      type: 'string',
      summary:
        'docker | binary | static | prebuilt — prebuilt is the line a Dockerfile runs inside the image build',
      default: 'docker',
    },
    { name: 'tag', type: 'string', summary: 'image tag (docker target)' },
    { name: 'out', type: 'string', summary: 'output path (binary and static targets)' },
    {
      name: 'preflight',
      type: 'boolean',
      summary:
        '--no-preflight skips the six static gate steps (typecheck, lint, boundaries, filesize, package-shape, errors) — only when `x verify` runs right after, as in `x build --no-preflight && x verify`',
    },
  ],
};
