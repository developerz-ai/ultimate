// `x design research` and `ui.research`, one body: each reference screened, captured, mapped and
// written as its five artefacts under `<out>/<slug>/`, then up to `follow` of its links visited the
// same way. Each directory is built aside and published whole (`cmd-design-publish.ts`). The browser
// and the theme host are arguments, so a test runs the whole thing with a fake driver — and a
// fixture server reached through `trustedHosts`, which only a harness can pass.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/schema';
import type { DesignDriverFor } from './cmd-design-capture';
import { captureReference, pageRef } from './cmd-design-capture';
import { DesignAbortedError } from './cmd-design-errors';
import {
  designSlug,
  MOTION_MAP_FILE,
  REFERENCE_FILE,
  SOURCES_FILE,
  TOKENS_FILE,
} from './cmd-design-paths';
import { publishDirectory } from './cmd-design-publish';
import type { ThemeHost } from './cmd-design-theme';
import { acceptedProposal } from './cmd-design-theme';
import type { DesignHostPolicy } from './cmd-design-url';
import { followTargets, readReferenceUrl, screenReference } from './cmd-design-url';
import { mapDesign } from './design-map';
import { postureFor } from './messages-design';
import { hash8 } from './shot-diff';
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
  /** The caller's cancellation: checked before every reference and every browser launch. */
  readonly signal?: AbortSignal | undefined;
}

export interface ResearchedReference {
  /** A typed URL as typed; a followed one as `pageRef` — its path is the page's text. */
  readonly url: string;
  /** Always `pageRef`: `location.href` is page-settable. */
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

/** A `--follow` link that failed: recorded, and the run went on. Code only — no page text. */
export interface SkippedReference {
  readonly url: string;
  readonly followedFrom: string;
  readonly code: string;
}

export interface ResearchOutcome {
  readonly references: readonly ResearchedReference[];
  readonly skipped: readonly SkippedReference[];
}

const json = async (file: string, value: unknown): Promise<void> => {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
};

interface Visit {
  /** What the browser navigates to. */
  readonly url: string;
  /** What files and answers name it by. */
  readonly shown: string;
  readonly slug: string;
  readonly followedFrom: string | null;
}

async function researchOne(
  visit: Visit,
  options: ResearchOptions,
): Promise<{ readonly reference: ResearchedReference; readonly links: readonly string[] }> {
  if (options.signal?.aborted === true) throw new DesignAbortedError({ url: visit.shown });
  await screenReference(visit.url, options.policy);
  const dir = join(options.outDir, visit.slug);
  const at = (name: string) => join(dir, name);
  return publishDirectory(dir, async (building) => {
    const capture = await captureReference({
      url: visit.url,
      dir: building,
      viewports: options.viewports,
      timeoutMs: options.timeoutMs,
      policy: options.policy,
      driverFor: options.driverFor,
      signal: options.signal,
    });
    const mapped = mapDesign(capture.byScheme, options.themeHost?.tables);
    const accepted = acceptedProposal(mapped.proposal, options.themeHost);
    const light = capture.byScheme.light;
    const researchedAt = options.now().toISOString();
    // Measured values only: channels, numbers, CSS keywords, bounded family names, hostnames.
    await json(join(building, REFERENCE_FILE), {
      url: visit.shown,
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
      refused: {
        count: capture.refusedHosts.length,
        hosts: capture.refusedHosts,
        unresolved: capture.unresolvedHosts,
      },
      tokens: {
        validated: accepted.validated,
        coloursProposed: accepted.proposal.colors !== undefined,
      },
    });
    await json(join(building, TOKENS_FILE), accepted.proposal);
    await json(join(building, MOTION_MAP_FILE), { url: visit.shown, entries: mapped.motionMap });
    const { source, posture } = postureFor(visit.url);
    await json(join(building, SOURCES_FILE), {
      url: visit.shown,
      finalUrl: capture.finalUrl,
      followedFrom: visit.followedFrom,
      researchedAt,
      source,
      posture,
      rule: 'ideas and techniques only: never copy code from a reference into the app',
    });
    return {
      reference: {
        url: visit.shown,
        finalUrl: capture.finalUrl,
        dir,
        followedFrom: visit.followedFrom,
        // Named where they will be once published, not where they were built.
        shots: capture.shots.map((file) => at(file.slice(building.length + 1))),
        files: {
          reference: at(REFERENCE_FILE),
          tokens: at(TOKENS_FILE),
          motionMap: at(MOTION_MAP_FILE),
          sources: at(SOURCES_FILE),
        },
        colors: mapped.palette.light.length,
        animations: light.motion.length,
        refused: capture.refusedHosts.length,
        validated: accepted.validated,
      },
      links: light.links,
    };
  });
}

/** A typed URL's slug, made unique against the ones this run already wrote. */
const uniqueSlug = (url: string, taken: ReadonlySet<string>): string => {
  const slug = designSlug(url);
  return taken.has(slug) ? `${slug}-${hash8(url)}` : slug;
};

/**
 * Every typed reference in order, each followed by up to `follow` of its own links. A typed URL
 * fails the run; a followed link that fails is recorded in `skipped` and the run goes on — one
 * broken catalogue entry is not a reason to throw away the rest. Cancellation always propagates.
 */
export async function researchDesign(options: ResearchOptions): Promise<ResearchOutcome> {
  // Every typed URL judged before the first browser: a typo in the third must not cost two captures.
  const urls = options.urls.map(readReferenceUrl);
  const references: ResearchedReference[] = [];
  const skipped: SkippedReference[] = [];
  const taken = new Set<string>();
  for (const url of urls) {
    const slug = uniqueSlug(url, taken);
    taken.add(slug);
    const first = await researchOne({ url, shown: url, slug, followedFrom: null }, options);
    references.push(first.reference);
    for (const link of followTargets(url, first.links, options.allowHosts, options.follow)) {
      // A followed page's directory never carries its path: the path is the page's text.
      const followed = { url: link, shown: pageRef(link), followedFrom: url };
      const linkSlug = `${slug}--${hash8(link)}`;
      if (taken.has(linkSlug)) continue;
      taken.add(linkSlug);
      try {
        references.push((await researchOne({ ...followed, slug: linkSlug }, options)).reference);
      } catch (error) {
        if (!isUltimateError(error) || error.code === 'X_ABORTED') throw error;
        skipped.push({ url: followed.shown, followedFrom: url, code: error.code });
      }
    }
  }
  return { references, skipped };
}

/** The `--json` / `ui.research` answer. */
export const researchJson = (outcome: ResearchOutcome): JsonValue => ({
  references: outcome.references.map((reference) => ({
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
  skipped: outcome.skipped.map((entry) => ({ ...entry })),
});
