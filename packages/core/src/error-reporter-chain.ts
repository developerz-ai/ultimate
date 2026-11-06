// Single responsibility: several `ErrorReporter`s behind the ONE seam — a vendor transport beside
// an app's own sink (`@ultimat3/admin`'s `errorGroupsSink`). Not a second seam: the chain IS a
// reporter, installed through `configureErrorReporting` like any other.

import { renderThrowable } from './error-render';
import { type ErrorReport, type ErrorReporter, noopErrorReporter } from './error-reporter';
import { logger } from './logger';

/** Which reporters a chain was built from — read back by `errorReportersOf`, never mutated. */
const members = new WeakMap<ErrorReporter, readonly ErrorReporter[]>();

/** The flat member list a reporter stands for: a chain's members, the no-op's none, else itself. */
export function errorReportersOf(reporter: ErrorReporter): readonly ErrorReporter[] {
  if (reporter === noopErrorReporter) return [];
  return members.get(reporter) ?? [reporter];
}

/**
 * One reporter that hands every report to each member, in order. A member that throws is logged
 * and costs ONLY itself — `reportError`'s own catch guards the whole reporter, so without this one
 * a vendor that is down would silence every member after it. Chains flatten and a member listed
 * twice reports once, so a boot that composes with what is installed cannot double a sink.
 */
export function chainErrorReporters(...reporters: readonly ErrorReporter[]): ErrorReporter {
  const flat = [...new Set(reporters.flatMap(errorReportersOf))];
  if (flat.length === 0) return noopErrorReporter;
  if (flat.length === 1) return flat[0] ?? noopErrorReporter;
  const chain: ErrorReporter = {
    report(event: ErrorReport): void {
      flat.forEach((member, index) => {
        try {
          member.report(event);
        } catch (failure) {
          logger.warn('error reporter failed', {
            source: event.source,
            member: index,
            error: renderThrowable(failure),
          });
        }
      });
    },
  };
  members.set(chain, Object.freeze(flat));
  return chain;
}
