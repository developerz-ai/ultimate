// Single responsibility: `x repro --bundle`'s answer — redact the subject, read what the scrubber
// must hide and what the framework is, assemble the one JSON document and write it under `repro/`.
// The parts are `repro-redact.ts`, `repro-archive-collect.ts`, `repro-scrub.ts`, `repro-archive.ts`.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { ReproErrorFacts } from './repro-archive';
import { bundleFileOf, reproArchive } from './repro-archive';
import { installedFramework, registryLookups, scrubSourcesOf } from './repro-archive-collect';
import type { ReproSubject } from './repro-bundle';
import type { RedactOptions, ReproLookups } from './repro-redact';
import { redactSubject } from './repro-redact';
import { scrubberFor } from './repro-scrub';
import { loadVersion } from './version-loader';

export async function writeBundle(
  root: string,
  ctx: CommandContext,
  subject: ReproSubject,
  error: ReproErrorFacts,
  options: RedactOptions,
  lookups: ReproLookups = registryLookups,
): Promise<CommandResult> {
  const redacted = redactSubject(subject, lookups, options);
  const scrubber = scrubberFor(await scrubSourcesOf(root, ctx.env));
  const { document, scrubbed } = reproArchive({
    ...redacted,
    error,
    framework: {
      packages: await installedFramework(root),
      cli: loadVersion(),
      bun: ctx.bunVersion,
      platform: `${process.platform}-${process.arch}`,
    },
    scrubber,
  });
  const file = bundleFileOf(subject);
  await Bun.write(join(root, file), `${JSON.stringify(document, null, 2)}\n`);
  return {
    ok: true,
    command: 'repro',
    summary: msg('cli.repro.bundled', { file }),
    lines: [
      msg('cli.repro.bundleMasked', { count: redacted.masked.length }),
      msg('cli.repro.bundleScrubbed', { env: scrubbed.env.length, hosts: scrubbed.hosts }),
      msg('cli.repro.bundleReadFirst', { file }),
    ],
    data: {
      kind: subject.kind,
      file,
      masked: [...redacted.masked],
      dropped: [...redacted.dropped],
      scrubbed: { env: [...scrubbed.env], hosts: scrubbed.hosts },
      includeRows: options.includeRows,
    } satisfies Record<string, JsonValue>,
  };
}
