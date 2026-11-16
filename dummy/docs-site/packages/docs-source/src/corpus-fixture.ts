// A wiki in miniature: a page with a cross-page link, the split error reference (an
// index and two owner pages) and a split Upgrading page. Each test file builds its corpus from these, so a rule is held on one shape.

import type { WikiFile } from './types';

export const FIXTURE_OPTIONS = { maxChars: 100_000, footer: '#footer' } as const;

export const HOME: WikiFile = {
  file: 'Home.md',
  markdown: [
    '# Ultimate',
    '',
    'The manual. See [codes](Error-Codes#reserved-codes) and [the footer](_Footer).',
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
    'Run it. [up](#install) [drift](Error-Codes-db) [repo](https://github.com/developerz-ai/ultimate)',
  ].join('\n'),
};

/** The index: rules, the generated per-code index (codes PLAIN), and the reserved block. */
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
    '<!-- error-codes:index -->',
    '## Every code',
    '',
    '| Code | Means | Page |',
    '|---|---|---|',
    '| X_DB_DRIFT | schema differs | [db](Error-Codes-db) |',
    '<!-- /error-codes:index -->',
    '',
    '## Reserved codes',
    '',
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '| `X_R` | reserved | nothing throws it | `x help` |',
  ].join('\n'),
};

/** Two owner pages: each one table, no `##` sections, a code (`X_A`) with a row on both. */
export const CORE_CODES: WikiFile = {
  file: 'Error-Codes-core.md',
  markdown: [
    '# Error codes: `@ultimat3/core`',
    '',
    'Part of [Error codes](Error-Codes): what core throws.',
    '',
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '| `X_A` / `X_B` | two at once | either \\| both | see [reserved](Error-Codes#reserved-codes) |',
    '| plain | not a code | x | y |',
  ].join('\n'),
};

export const DB_CODES: WikiFile = {
  file: 'Error-Codes-db.md',
  markdown: [
    '# Error codes: `@ultimat3/db`',
    '',
    'Part of [Error codes](Error-Codes): what db throws.',
    '',
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '| `X_A` | again | from another side | z |',
    '| `X_DB_DRIFT` | schema differs | a column [moved](Getting-Started#install) | `x db gen` |',
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
  // In the order the site reads them: sorted by file name, so the owner pages come first.
  CORE_CODES,
  DB_CODES,
  CODES,
  UPGRADING,
  { file: '_Sidebar.md', markdown: '[Home](Home)' },
];
