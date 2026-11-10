// `@ultimat3/query/loader` — where an export is NAMED as a query: `x`'s module scan and the
// framework's own fixtures. Never the `.` barrel: an app hands its modules to `defineApi`, the one
// registration path (axiom 1), and that reaches these through core's registrar table.

export { registerQueries, registerQuery } from './registry';
