// The agent kit's one list: every managed skill and agent, the path it lands on, and the marker
// that opts an app in. `x new` writes it, `x kit` re-renders it, the gate diffs it — all three read
// THIS table, so a kit file cannot exist in one projection and be missing from another.

import type { GeneratedSourceFile, NameSet } from '../templates/naming';
import { auditAgent } from './agent-audit';
import { dataAgent } from './agent-data';
import { serverAgent } from './agent-server';
import { shapeAgent } from './agent-shape';
import { webAgent } from './agent-web';
import { designResearchSkill } from './skill-design-research';
import { featureSkill } from './skill-feature';
import { planxSkill } from './skill-planx';
import { upgradeSkill } from './skill-upgrade';
import { verifySkill } from './skill-verify';

/** The opt-in marker. Present ⇒ kit findings are errors; absent ⇒ one warning. App-owned. */
export const KIT_MARKER = '.claude/kit.json';

export type KitKind = 'skill' | 'agent';

export type KitSkillName = 'feature' | 'planx' | 'verify' | 'upgrade' | 'design-research';
export type KitAgentName = 'shape' | 'data' | 'server' | 'web' | 'audit';
/** Skill and agent names are disjoint, so `kit.json`'s `"off"` names an entry by name alone. */
export type KitEntryName = KitSkillName | KitAgentName;

export interface KitEntry {
  readonly name: KitEntryName;
  readonly kind: KitKind;
  /** POSIX path relative to the app root. */
  readonly path: string;
  readonly render: (app: NameSet) => string;
}

/** A rendered managed file: a `GeneratedSourceFile` whose contents are always text. */
export interface KitFile extends GeneratedSourceFile {
  readonly contents: string;
  readonly name: KitEntryName;
  readonly kind: KitKind;
}

const skill = (name: KitSkillName, render: (app: NameSet) => string): KitEntry => ({
  name,
  kind: 'skill',
  path: `.claude/skills/${name}/SKILL.md`,
  render,
});

const agent = (name: KitAgentName, render: (app: NameSet) => string): KitEntry => ({
  name,
  kind: 'agent',
  path: `.claude/agents/${name}.md`,
  render,
});

/** Every managed entry, in the order `x new` writes them. */
export const KIT_ENTRIES: readonly KitEntry[] = [
  skill('feature', featureSkill),
  skill('planx', planxSkill),
  skill('verify', verifySkill),
  skill('upgrade', upgradeSkill),
  skill('design-research', designResearchSkill),
  agent('shape', shapeAgent),
  agent('data', dataAgent),
  agent('server', serverAgent),
  agent('web', webAgent),
  agent('audit', auditAgent),
];

/**
 * The paths `x kit` owns. Not the marker (the app edits its `"off"` list) and never
 * `apps/web/DESIGN.md` (app-owned from the moment it lands).
 */
export const MANAGED_KIT_PATHS: readonly string[] = KIT_ENTRIES.map((entry) => entry.path);

/** The managed files, rendered for one app: exactly one per `MANAGED_KIT_PATHS` entry, same order. */
export function kitFiles(app: NameSet): readonly KitFile[] {
  return KIT_ENTRIES.map((entry) => ({
    path: entry.path,
    contents: entry.render(app),
    name: entry.name,
    kind: entry.kind,
  }));
}

/** The marker as `x new` writes it: opted in, nothing switched off. */
export function kitMarkerFile(): GeneratedSourceFile {
  return { path: KIT_MARKER, contents: `${JSON.stringify({ off: [] }, null, 2)}\n` };
}
