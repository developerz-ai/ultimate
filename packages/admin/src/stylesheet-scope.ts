// Every stylesheet of this package belongs to the `app/` surface. The admin's screens are served
// there and nowhere else, and a package sheet nobody claims rides BOTH surface bundles — so an
// app that declared an admin shipped the dashboard's CSS in every static `site/` document
// (axiom 6: the static path never pays for the app path). Imported for this one side effect.

import { claimStylesheets } from '@ultimat3/render/server';

claimStylesheets(import.meta.dir, 'app');
