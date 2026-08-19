// The build gate. A `site/` route without a title or description does not warn —
// it throws X_SEO_META_MISSING naming the exact file and the exact edit. Also
// catches the three failures that only show up weeks later in Search Console:
// duplicate meta, an over-length title, and a canonical that lies.

import {
  canonicalMismatch,
  duplicateMeta,
  metaMissing,
  metaTooLong,
  SeoError,
  type SeoErrorCode,
  titleTemplateSlotMissing,
} from './errors';
import { applyTitleTemplate, DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH, TITLE_SLOT } from './meta';
import { indexableRoutes, isDynamic, type RouteRecord } from './routes';
import { absoluteUrl } from './xml';

export interface MetaIssue {
  readonly code: string;
  readonly route: string;
  readonly file: string;
  readonly cause: string;
  readonly fix: string;
}

/** `--json`-shaped: the CLI prints this verbatim under `x verify --json`. */
export interface MetaValidationReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly issues: readonly MetaIssue[];
}

export interface ValidateMetaOptions {
  /** Required to check canonicals. Without it, canonical checks are skipped. */
  baseUrl?: string;
  titleMaxLength?: number;
  descriptionMaxLength?: number;
  /** Report duplicates across routes. On by default. */
  checkDuplicates?: boolean;
}

function issueOf(error: SeoError, route: string, file: string): MetaIssue {
  return { code: error.code, route, file, cause: error.cause, fix: error.fix };
}

export function validateMeta(
  routes: readonly RouteRecord[],
  options: ValidateMetaOptions = {},
): MetaValidationReport {
  const titleMax = options.titleMaxLength ?? TITLE_MAX_LENGTH;
  const descriptionMax = options.descriptionMaxLength ?? DESCRIPTION_MAX_LENGTH;
  const checked = indexableRoutes(routes);
  const issues: MetaIssue[] = [];

  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();

  for (const route of checked) {
    const meta = route.meta ?? {};

    if (meta.title === undefined || meta.title.trim() === '') {
      issues.push(issueOf(metaMissing(route.file, route.path, 'title'), route.path, route.file));
    } else {
      // An empty template is "no template" and applies nothing; a non-empty one that cannot place
      // the title silently discards it, which is the one the renderer cannot report.
      const template = meta.titleTemplate ?? '';
      if (template !== '' && !template.includes(TITLE_SLOT)) {
        issues.push(
          issueOf(titleTemplateSlotMissing(route.file, route.path), route.path, route.file),
        );
      }
      const rendered = applyTitleTemplate(meta.title, meta.titleTemplate);
      if (rendered.length > titleMax) {
        issues.push(
          issueOf(
            metaTooLong(route.file, 'title', rendered.length, titleMax),
            route.path,
            route.file,
          ),
        );
      }
      push(titles, rendered, route.file);
    }

    if (meta.description === undefined || meta.description.trim() === '') {
      issues.push(
        issueOf(metaMissing(route.file, route.path, 'description'), route.path, route.file),
      );
    } else {
      if (meta.description.length > descriptionMax) {
        issues.push(
          issueOf(
            metaTooLong(route.file, 'description', meta.description.length, descriptionMax),
            route.path,
            route.file,
          ),
        );
      }
      push(descriptions, meta.description, route.file);
    }

    // A canonical is only checkable for a static path: a dynamic route's
    // canonical is produced per-item at render time.
    if (meta.canonical !== undefined && options.baseUrl !== undefined && !isDynamic(route.path)) {
      const expected = absoluteUrl(options.baseUrl, route.path);
      const actual = absoluteUrl(options.baseUrl, meta.canonical);
      if (actual !== expected) {
        issues.push(
          issueOf(canonicalMismatch(route.file, actual, expected), route.path, route.file),
        );
      }
    }
  }

  if (options.checkDuplicates !== false) {
    issues.push(...duplicates(titles, 'title'), ...duplicates(descriptions, 'description'));
  }

  return { ok: issues.length === 0, checked: checked.length, issues };
}

function push(index: Map<string, string[]>, key: string, file: string): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [file]);
  else existing.push(file);
}

function duplicates(index: Map<string, string[]>, field: string): MetaIssue[] {
  const out: MetaIssue[] = [];
  for (const [value, files] of index) {
    if (files.length < 2) continue;
    const error = duplicateMeta(field, value, files);
    out.push({
      code: error.code,
      route: files.join(', '),
      file: files[0] ?? '',
      cause: error.cause,
      fix: error.fix,
    });
  }
  return out;
}

/**
 * Throws on the first issue. `x verify` does NOT call this — `As of 2026-08` nothing outside this
 * package imports it, and wiring it is a `HostCheck` on an existing step in
 * `packages/cli/src/cmd-verify.ts`. Today it fails an app that calls it itself, which is what
 * `README.md` says and what this line claimed the opposite of.
 */
export function assertMeta(report: MetaValidationReport): void {
  const first = report.issues[0];
  if (first === undefined) return;
  throw new SeoError({
    code: first.code as SeoErrorCode,
    cause: first.cause,
    fix: first.fix,
    meta: { route: first.route, file: first.file, totalIssues: report.issues.length },
  });
}
