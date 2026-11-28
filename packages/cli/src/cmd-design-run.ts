// `x design research` and `ui.research`, one body: each reference screened, captured, mapped and
// written as its five artefacts under `<out>/<slug>/`, then up to `follow` of its links visited the
// same way. The browser and the theme host are arguments, so a test runs the whole thing with a fake
// driver — and a fixture server reached through `trustedHosts`, which only a harness can pass.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { JsonValue } from '@ultimat3/schema';
import type { DesignDriverFor } from './cmd-design-capture';
import { captureReference } from './cmd-design-capture';
import {
  designSlug,
  MOTION_MAP_FILE,
  REFERENCE_FILE,
  SOURCES_FILE,
  TOKENS_FILE,
} from './cmd-design-paths';
import type { ThemeHost } from './cmd-design-theme';
import { acceptedProposal } from './cmd-design-theme';
import type { DesignHostPolicy } from './cmd-design-url';
import { followTargets, readReferenceUrl, screenReference } from './cmd-design-url';
import { mapDesign } from './design-map';
import { postureFor } from './messages-design';
import type { ShotViewport } from './shot-viewport';

export interface ResearchOptions {
  readonly urls: readonly string[];
  /** Links visited per typed reference, same origin or `allowHosts`. */
  readonly follow: number;
  /** Absolute. */
  readonly outDir: string;
  readonly viewports: readonly ShotViewport[];
  readonly allowHosts: readonly string[];
  readonly timeoutMs: number;
  readonly policy: DesignHostPolicy;
  readonly driverFor: DesignDriverFor;
  readonly themeHost: ThemeHost | undefined;
  readonly now: () => Date;
}

export interface ResearchedReference {
  readonly url: string;
  readonly finalUrl: string;
  readonly dir: string;
  readonly followedFrom: string | null;
  readonly shots: readonly string[];
  readonly files: Readonly<Record<'reference' | 'tokens' | 'motionMap' | 'sources', string>>;
  readonly colors: number;
  readonly animations: number;
  readonly refused: number;
  /** Whether `defineTheme` itself accepted `tokens.proposal.json`. */
  readonly validated: boolean;
}

const json = async (file: string, value: unknown): Promise<void> => {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
};

async function researchOne(
  url: string,
  followedFrom: string | null,
  options: ResearchOptions,
): Promise<{ readonly reference: ResearchedReference; readonly links: readonly string[] }> {
  await screenReference(url, options.policy);
  const dir = join(options.outDir, designSlug(url));
  const capture = await captureReference({
    url,
    dir,
    viewports: options.viewports,
    timeoutMs: options.timeoutMs,
    policy: options.policy,
    driverFor: options.driverFor,
  });
  const mapped = mapDesign(capture.byScheme, options.themeHost?.tables);
  const accepted = acceptedProposal(mapped.proposal, options.themeHost);
  const light = capture.byScheme.light;
  const researchedAt = options.now().toISOString();
  const files = {
    reference: join(dir, REFERENCE_FILE),
    tokens: join(dir, TOKENS_FILE),
    motionMap: join(dir, MOTION_MAP_FILE),
    sources: join(dir, SOURCES_FILE),
  };
  // Measured values only: channels, numbers, CSS keywords, sanitised family names. No page text.
  await json(files.reference, {
    url,
    finalUrl: capture.finalUrl,
    researchedAt,
    viewports: options.viewports,
    palette: mapped.palette,
    fonts: {
      families: [...new Set(light.fonts.map((font) => font.family))],
      scale: [...new Set(light.fonts.map((font) => font.sizePx))].sort((a, b) => a - b),
      usage: light.fonts,
    },
    spacing: [...light.spacing].sort((a, b) => a.px - b.px),
    radii: light.radii,
    shadows: light.shadows,
    backdropFilter: light.backdrop,
    canvases: light.canvases,
    motion: light.motion,
    refused: { count: capture.refusedHosts.length, hosts: capture.refusedHosts },
    tokens: {
      validated: accepted.validated,
      coloursProposed: accepted.proposal.colors !== undefined,
    },
  });
  await json(files.tokens, accepted.proposal);
  await json(files.motionMap, { url, entries: mapped.motionMap });
  const { source, posture } = postureFor(url);
  await json(files.sources, {
    url,
    finalUrl: capture.finalUrl,
    followedFrom,
    researchedAt,
    source,
    posture,
    rule: 'ideas and techniques only: never copy code from a reference into the app',
  });
  return {
    reference: {
      url,
      finalUrl: capture.finalUrl,
      dir,
      followedFrom,
      shots: capture.shots,
      files,
      colors: mapped.palette.light.length,
      animations: light.motion.length,
      refused: capture.refusedHosts.length,
      validated: accepted.validated,
    },
    links: light.links,
  };
}

/** Every typed reference in order, each followed by up to `follow` of its own links. */
export async function researchDesign(
  options: ResearchOptions,
): Promise<readonly ResearchedReference[]> {
  // Every typed URL judged before the first browser: a typo in the third must not cost two captures.
  const urls = options.urls.map(readReferenceUrl);
  const out: ResearchedReference[] = [];
  for (const url of urls) {
    const first = await researchOne(url, null, options);
    out.push(first.reference);
    for (const link of followTargets(url, first.links, options.allowHosts, options.follow)) {
      out.push((await researchOne(link, url, options)).reference);
    }
  }
  return out;
}

/** The `--json` / `ui.research` answer. */
export const researchJson = (references: readonly ResearchedReference[]): JsonValue => ({
  references: references.map((reference) => ({
    url: reference.url,
    finalUrl: reference.finalUrl,
    dir: reference.dir,
    followedFrom: reference.followedFrom,
    shots: [...reference.shots],
    files: { ...reference.files },
    colors: reference.colors,
    animations: reference.animations,
    refused: reference.refused,
    validated: reference.validated,
  })),
});
