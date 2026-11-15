// The `x status` rows of the CLI catalog (`messages.ts` composes them): what the running
// deployment records about its builds, and which roles record nothing. Data only.

export const STATUS_MESSAGES = {
  'cli.status.summary': '{workers} live worker(s) read, {origins} origin(s) sampled',
  'cli.status.workers': 'workers: {count} live · builds {builds}',
  'cli.status.origin': '{origin}: {samples} sample(s) · builds {builds} · status {statuses}',
  'cli.status.unrecorded':
    'no fleet-wide record of {roles}: pass each one’s health origin to --url to read its build',
} as const;
