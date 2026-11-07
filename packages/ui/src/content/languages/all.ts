// Every built-in language, for a SERVER page where bytes cost nothing. An island passes only the
// languages it shows: importing this module from one retains all seven.

import type { Language } from '../highlight';
import { diffLanguage } from './diff';
import { htmlLanguage } from './html';
import { jsonLanguage } from './json';
import { shellLanguage } from './shell';
import { sqlLanguage } from './sql';
import { tsLanguage } from './ts';
import { yamlLanguage } from './yaml';

export const allLanguages: readonly Language[] = [
  tsLanguage,
  jsonLanguage,
  shellLanguage,
  sqlLanguage,
  htmlLanguage,
  yamlLanguage,
  diffLanguage,
];
