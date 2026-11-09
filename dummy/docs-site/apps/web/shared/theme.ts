// This app's brand: the boot reads `brand` from this file and inlines it in every document,
// after global.scss, with its hash in the CSP. `defineTheme({})` is @ultimat3/ui's default theme
// and renders nothing, so today no tag is emitted.
//
// `defineTheme()` is the one seam for restyling — colours, radii, fonts and shadows by role,
// validated at the call. The dashboard look (near-black panels, a cyan accent, glowing edges, its
// own eight chart series) is one edit:
//
//   export const brand = defineTheme({ preset: 'scifi' });
//
// Every other slot layers onto the preset role by role:
//   defineTheme({ preset: 'scifi', colors: { dark: { 'chart-1': '120 220 255' } } })
// A preset never forces a theme: to open dark whatever the OS says, set `theme.defaultMode` in
// app.config.ts.
import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({});
