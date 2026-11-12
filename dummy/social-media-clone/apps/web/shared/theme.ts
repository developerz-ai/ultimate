// The app's brand, and the one place it is declared: the framework reads `brand` from this file and
// appends it to every surface stylesheet the documents link — pages, the admin, the static export —
// so it is last in the cascade and cached as an immutable file. The deployed demo is the showcase
// for the sci-fi preset; `defineTheme()` measures it against WCAG AA when this imports.

import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({ preset: 'scifi' });
