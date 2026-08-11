// SCSS modules resolve to a class-name map at build time. Ambient because an import cannot
// reach a declaration file — every surface names this file in its tsconfig "include".

declare module '*.module.scss' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
