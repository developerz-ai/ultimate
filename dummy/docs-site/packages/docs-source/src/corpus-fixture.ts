// A wiki in miniature: a page with a cross-page link, a split Error-Codes page and a split
// Upgrading page. Each test file builds its corpus from these, so a rule is held on one shape.

import type { WikiFile } from './types';

export const FIXTURE_OPTIONS = { maxChars: 100_000, footer: '#footer' } as const;

export const HOME: WikiFile = {
  file: 'Home.md',
  markdown: [
    '# Ultimate',
    '',
    'The manual. See [codes](Error-Codes#core) and [the footer](_Footer).',
  ].join('\n'),
};

export const GUIDE: WikiFile = {
  file: 'Getting-Started.md',
  markdown: [
    '# Getting started',
    '<!-- a note for editors -->',
    'Four commands. [Move to 30](Upgrading#29x--3000-entry-by-entry), [removed](Upgrading#removed-1).',
    '',
    '## Install',
    '',
    'Run it. [up](#install) [drift](Error-Codes) [repo](https://github.com/developerz-ai/ultimate)',
  ].join('\n'),
};

export const CODES: WikiFile = {
  file: 'Error-Codes.md',
  markdown: [
    '# Error codes',
    '',
    'Every failure carries a code.',
    '',
    '| Rule | Detail |',
    '|---|---|',
    '| `X_NOT_A_ROW` | a rule table row stays |',
    '',
    '## Core',
    '',
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '| `X_DB_DRIFT` | schema differs | a column [moved](Getting-Started#install) | `x db gen` |',
    '| `X_A` / `X_B` | two at once | either \\| both | see [core](#core) |',
    '| plain | not a code | x | y |',
    '',
    '## Later',
    '',
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '| `X_A` | again | from another side | z |',
  ].join('\n'),
};

export const UPGRADING: WikiFile = {
  file: 'Upgrading.md',
  markdown: [
    '# Upgrading',
    '',
    'One major per run.',
    '',
    '## 29.x → 30.0.0, entry by entry',
    '',
    'Thirty moved things.',
    '',
    '### Removed',
    '',
    'A thing. [back](#what-semver-covers)',
    '',
    '## 28.x → 29.0.0, entry by entry',
    '',
    'Twenty-nine.',
    '',
    '### Removed',
    '',
    'Another thing.',
    '',
    '## What semver covers',
    '',
    'The shapes.',
  ].join('\n'),
};

export const WIKI: readonly WikiFile[] = [
  HOME,
  GUIDE,
  CODES,
  UPGRADING,
  { file: '_Sidebar.md', markdown: '[Home](Home)' },
];
