// The GitHub-owned actions the workflows `x new` writes run, each pinned by commit SHA with its
// version in the trailing comment: a major tag is a pointer its owner (or whoever holds its token)
// can move under every app at once. The framework's own workflows run these exact pins, and the
// app's Dependabot `github-actions` group moves SHA and comment together.

export const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

export const CACHE = 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0';

export const UPLOAD_ARTIFACT =
  'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';

export const DOWNLOAD_ARTIFACT =
  'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2';
