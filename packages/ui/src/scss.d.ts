// SCSS modules resolve to a class-name map at build time. The default export is
// the bundler's contract, not ours — component code never re-exports it.

declare module '*.module.scss' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
