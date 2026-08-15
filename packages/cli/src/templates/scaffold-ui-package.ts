// The generated app's `packages/ui`: one example component on top of @ultimat3/ui, so the app has
// a worked instance of the semantic-token rule before it writes its own. Imported by `site/`, so
// its byte budget is the landing page's.

import type { GeneratedFile, NameSet } from './naming';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const DESCRIPTION = 'App components on @ultimat3/ui';

const uiIndex =
  (): string => `// App components on top of @ultimat3/ui. Same byte budgets as shared/: this package is imported
// by site/, so a chart library in here costs the landing page.
export { Card } from './card';
`;

const uiCard = (): string => `import type { JSX } from 'solid-js';
import styles from './card.module.scss';

export interface CardProps {
  readonly title: string;
  readonly children?: JSX.Element;
}

export function Card(props: CardProps) {
  return (
    <section class={styles.card}>
      <h2 class={styles.title}>{props.title}</h2>
      {props.children}
    </section>
  );
}
`;

const uiCardStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.card {
  padding: tokens.space(4);
  border-radius: tokens.radius('md');
  background: tokens.role('surface-raised');
  color: tokens.role('fg');
}

.title {
  font-size: tokens.text('lg');
  font-weight: tokens.weight('semibold');
}
`;

/** Every file the `packages/ui` workspace ships, in the order `x new` writes them. */
export const uiPackageFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: 'packages/ui/package.json', contents: workspacePackageJson(app, 'ui', DESCRIPTION) },
  ...packageShapeFiles(app, 'ui', DESCRIPTION),
  { path: 'packages/ui/src/index.ts', contents: uiIndex() },
  { path: 'packages/ui/src/card.tsx', contents: uiCard() },
  { path: 'packages/ui/src/card.module.scss', contents: uiCardStyle() },
];
