// SCSS modules resolve to a class-name map at build time. Ambient because an import cannot
// reach a declaration file — every surface names this file in its tsconfig "include".

declare module '*.module.scss' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

// A plain stylesheet is the global layer: it emits top-level CSS and has no class map worth
// binding, so `shared/global.ts` imports it for the side effect alone. Without this declaration
// `tsc` reports TS2307 on the one import that puts the app's tokens in the document.
declare module '*.scss' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
