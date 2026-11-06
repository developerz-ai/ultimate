/**
 * The public origin server-side code builds absolute URLs from — an invite mail's button, the
 * authorization server's issuer. `APP_URL`, as `.env.example` sets it; its loopback value where it
 * is unset (`bun test`, `x exercise`), because a mail client follows only an absolute link.
 */
export const appOrigin = (): string => Bun.env['APP_URL'] || 'http://localhost:3000';
