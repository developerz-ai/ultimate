// Which files of a slice declare an entity. The first is `entity.ts`; every further one is a
// sibling, `entity-<name>.ts`, with its own `repo-<name>.ts` — one file, one table. Every reader of
// "the entity files this run wrote" asks here: three of them matched `/entity.ts` alone, so a
// second entity in a feature could be written by nothing and registered by nothing.

/**
 * `apps/<app>/<surface>/<feature>/entity.ts` or `…/entity-<name>.ts` — never a test beside it. A
 * slice nests (`app/runs/canary/entity.ts`) as freely as any other feature directory does, so the
 * feature is one segment or more: a depth-one rule refused a nested slice's entity at the package
 * boundary while the app's own surface rules accepted the same file.
 */
const ENTITY_MODULE =
  /^apps\/[^/]+\/(?<rest>[^/]+(?:\/[a-z0-9-]+)+)\/(?<stem>entity(?:-[a-z0-9-]+)?)\.ts$/;

/** Whether `path` is a module a generator declares an entity in. */
export const isEntityModule = (path: string): boolean => ENTITY_MODULE.test(path);

/** `app/blog/entity-blog-attempt` for a web-workspace entity module; `undefined` for any other. */
export const entityModuleIn = (path: string, workspace: string): string | undefined => {
  if (!path.startsWith(`${workspace}/`)) return undefined;
  const groups = ENTITY_MODULE.exec(path)?.groups;
  return groups === undefined ? undefined : `${groups['rest']}/${groups['stem']}`;
};

/** The two module names an entity's files take: the slice's first, or a named sibling's. */
export interface EntityStems {
  readonly entity: string;
  readonly repo: string;
}

export const entityStems = (kebabName: string, sibling: boolean): EntityStems =>
  sibling
    ? { entity: `entity-${kebabName}`, repo: `repo-${kebabName}` }
    : { entity: 'entity', repo: 'repo' };
