/**
 * The page's keyboard layer, rendered inside the feed island: `⌘K`/`Ctrl K` opens the command
 * palette over the app's destinations and the feed's own posts, and `?` lists every binding that
 * works — the palette's row included, because both read the page's one hotkey table.
 *
 * Here and not in `layout.tsx`: an island belongs to the route that declares it, and the layout is
 * evaluated for every page. The feed already ships Solid and the design system, so the keyboard
 * layer costs this page the palette's own bytes and no second runtime.
 *
 * Not loaded on first intent, measured 2026-11-06: here it is 16,414 B of the feed island. As its
 * own island it is 48,759 B (its own Solid and ui), and an `import()` of this file is inlined into
 * the unsplit island chunk (96,046 → 99,082 B) and charged by the budget either way.
 */

import { navigate } from '@ultimat3/render/client';
import {
  CommandPalette,
  type CommandPaletteItem,
  type CommandPaletteLabels,
  ShortcutSheet,
  useCommandPalette,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';

/** Already translated on the server: an island's props cross as JSON. */
export interface CommandLabels extends CommandPaletteLabels {
  /** The group heading over the app's destinations. */
  readonly goTo: string;
  /** The group heading over the feed's posts. */
  readonly posts: string;
}

export interface Destination {
  readonly label: string;
  readonly href: string;
}

export interface FeedCommandsProps {
  readonly labels: CommandLabels;
  readonly destinations: readonly Destination[];
  /** The feed's posts as they stand: the palette finds one by title. */
  readonly posts: () => readonly { readonly title: string; readonly href: string }[];
}

export function FeedCommands(props: FeedCommandsProps): JSX.Element {
  const palette = useCommandPalette({
    label: props.labels.title,
    items: (): readonly CommandPaletteItem[] => [
      ...props.destinations.map((to) => ({
        id: to.href,
        label: to.label,
        hint: to.href,
        group: props.labels.goTo,
      })),
      ...props
        .posts()
        .map((post) => ({ id: post.href, label: post.title, hint: '', group: props.labels.posts })),
    ],
    onRun: (item) => void navigate(item.id),
  });
  return (
    <>
      <CommandPalette {...palette.props} labels={props.labels} />
      <ShortcutSheet />
    </>
  );
}
