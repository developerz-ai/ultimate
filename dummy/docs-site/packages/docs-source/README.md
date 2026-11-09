# @docs-site/docs-source

The wiki reader of the docs-site app: `readCorpus(files)` turns `wiki/*.md` into the pieces the site
renders — a page per wiki file, a page per `X_*` code, a page per upgrade major — with every wiki
link rewritten to the URL that now holds its target. Pure; part of the docs-site monorepo — see the
root README for how it fits.
