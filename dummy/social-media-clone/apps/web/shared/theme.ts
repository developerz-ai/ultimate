// The app's brand, and the one place it is declared: the framework reads `brand` from this file and
// inlines it after the surface stylesheet in every document it renders — pages, the admin, the
// static export — admitting it to `style-src` from the same string. The deployed demo is the
// showcase for the sci-fi preset; `defineTheme()` measures it against WCAG AA when this imports.

import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({ preset: 'scifi' });
