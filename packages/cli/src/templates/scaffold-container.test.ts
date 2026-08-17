// The generated compose file is the deploy story in a file, and a service that is silently the
// wrong process is the one failure a rolling deploy cannot see. Asserted at the template, because
// the alternative is discovering it in whoever's production ran `x new` first.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { containerFiles } from './scaffold-container';

const APP = names('my-app');

const fileAt = (path: string): string => {
  const found = containerFiles(APP).find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`no generated ${path}`);
  return found.contents;
};

/** Each `services:` entry as its own text, keyed by name — services sit at exactly two spaces. */
function serviceBlocks(compose: string): ReadonlyMap<string, string> {
  const lines = compose.split('\n');
  const start = lines.indexOf('services:');
  const blocks = new Map<string, string>();
  let name: string | undefined;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}(?<name>[a-z][\w-]*):\s*$/.exec(line)?.groups?.['name'];
    if (header !== undefined) {
      if (name !== undefined) blocks.set(name, body.join('\n'));
      name = header;
      body = [];
      continue;
    }
    // A line at column 0 that is not a service header ends the section (`volumes:`).
    if (line.length > 0 && !line.startsWith(' ')) break;
    body.push(line);
  }
  if (name !== undefined) blocks.set(name, body.join('\n'));
  return blocks;
}

describe('unit · the scaffolded container files', () => {
  // The image's ENTRYPOINT is `bun apps/web/server.ts`, and that entry reads ROLE and PORT and
  // NOTHING ELSE — argv never reaches a parser. A `command:` beside it is therefore appended to a
  // process that discards it, so `backfill` served HTTP as ROLE=web, forever, under a name that
  // said otherwise. A `command:` only means something with an `entrypoint:` that reads argv.
  test('every service that declares a command also overrides the entrypoint', () => {
    for (const [name, body] of serviceBlocks(fileAt('docker/docker-compose.prod.yml'))) {
      if (!body.includes('command:')) continue;
      expect(`${name}: ${body}`).toContain('entrypoint:');
    }
  });

  test('the backfill service runs the CLI, and asks for the write explicitly', () => {
    const backfill = serviceBlocks(fileAt('docker/docker-compose.prod.yml')).get('backfill');
    expect(backfill).toContain("entrypoint: ['bun', 'node_modules/@ultimat3/cli/src/bin.ts']");
    expect(backfill).toContain("command: ['db', 'backfill', '--all', '--write', '--json']");
  });

  // ROLE is the one knob the image's own entry point reads, so every role service must set it.
  test('every serving role selects itself through ROLE, never through argv', () => {
    for (const role of ['migrate', 'web', 'sync', 'worker', 'scheduler']) {
      expect(serviceBlocks(fileAt('docker/docker-compose.prod.yml')).get(role)).toContain(
        `environment: [ROLE=${role}]`,
      );
    }
  });
});
