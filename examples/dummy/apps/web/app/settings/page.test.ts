// /settings as a node tree, not as markup: what each element CARRIES. The editor's shell is the
// SAVED member row, so its date is formatted in that member's zone, a prop handed `<DateTime>`.
// `renderNodes` is the public walker, imported from `@ultimat3/core/render-nodes`: `renderRoute`
// answers what a reader sees, this answers what an element holds.

import { ctxOf, runWithContext } from '@ultimat3/core';
import { byComponent, byTag, one, type RenderNode, renderNodes } from '@ultimat3/core/render-nodes';
import { expect, unitTest } from '@ultimat3/testing';
import { useActor } from '../../shared/actor';
import { DEFAULT_DEMO_MEMBER, demoActorFor } from '../auth/demo-actor';
import { Page } from './page';

/** The page as the default demo member: the tree, and the member row it was rendered from. */
const rendered = (): { tree: RenderNode[]; tz: string; locale: string } =>
  runWithContext(ctxOf({ actor: demoActorFor(DEFAULT_DEMO_MEMBER) }), () => {
    const { member } = useActor();
    // `keep`: each component node stays beside its output, so the props `<DateTime>` was handed show.
    const tree = renderNodes(Page, {}, { components: 'keep' });
    return { tree, tz: member.tz, locale: member.locale };
  });

unitTest('the summary dates the saved row in the member’s own zone', () => {
  const { tree, tz } = rendered();
  const date = one(byComponent(tree, 'DateTime'), 'the summary’s <DateTime>');
  expect(date.props['timeZone']).toBe(tz);
  expect(date.props['dateStyle']).toBe('long');
});

unitTest('the island’s server shell is the saved row, one <dl> of three rows', () => {
  const { tree, locale } = rendered();
  const summary = one(byTag(tree, 'dl'), 'the summary');
  expect(summary.props['class']).toBeString();
  const rows = byTag(tree, 'dd');
  expect(rows).toHaveLength(3);
  expect(rows[0]?.props['children']).toBe(locale);
});

/** Every `<Text>` line the header draws, as text, for one demo member in one locale. */
const headerLines = (name: 'ada' | 'kenji' | 'bruno', locale: string): string[] =>
  runWithContext(ctxOf({ actor: demoActorFor(name), locale }), () =>
    byComponent(renderNodes(Page, {}, { components: 'keep' }), 'Text').map((node) =>
      String(node.props['children']),
    ),
  );

// The role line is a `select` family: one sentence per role, the unlisted role taking `_other` —
// a reader is never told they own the workspace, and each locale words its own grammar.
unitTest('the header says what the member’s role lets them do, per role and per locale', () => {
  expect(headerLines('ada', 'en')).toContain(
    'You own Acme Editorial: its plan and its billing are yours.',
  );
  expect(headerLines('kenji', 'en')).toContain('You read Acme Editorial.');
  expect(headerLines('bruno', 'es')).toContain('Escribes para Acme Editorial.');
});
