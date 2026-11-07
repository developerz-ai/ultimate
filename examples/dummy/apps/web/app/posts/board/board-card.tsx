/**
 * What the page's no-script board and the island share besides the columns: one card's look — the
 * title, linking to the post; the look is this app's, never the board's — and the fields
 * `movePostStatus` reads from a card's form. The board's index is not one: a status has no order.
 */

import { Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { BoardPost } from './board-columns';

export const MOVE_FIELDS = { id: 'id', fromGroup: 'from', toGroup: 'to', toIndex: null } as const;

export const postCard = (post: BoardPost): JSX.Element => (
  <Link href={`/posts/${post.id}`}>{post.title}</Link>
);
