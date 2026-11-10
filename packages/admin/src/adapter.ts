// `@ultimat3/admin/adapter` — what a host wiring an AI gateway into the admin reads: the shape of
// the function that narrows `@ultimat3/ai`'s `Gateway` to the runner a pane may call. Never the
// `.` barrel: an app declares an admin; only the code that hands it a gateway needs this.

export type { GatewayAdapter } from './ai-panes';
