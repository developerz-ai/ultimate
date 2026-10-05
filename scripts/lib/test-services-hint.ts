// What `bun run setup` prints so the live suites are one paste away, in the shell the contributor
// actually has: `set -a; . file; set +a` is bash, and PowerShell — native Windows, no WSL — reads
// none of it, so a Windows contributor was handed a command that cannot run there.

/** The file every live suite reads its URLs from; one `NAME=value` per line, `#` comments between. */
export const TEST_SERVICES_ENV = 'docker/test-services.env';

/**
 * Loads each `NAME=value` line into the session. `-split '=', 2` keeps a value's own `=` (a URL
 * query) intact, and `^[A-Z]` skips the comment header the file opens with.
 */
const POWERSHELL_LOAD = `Get-Content ${TEST_SERVICES_ENV} | Where-Object { $_ -match '^[A-Z]' } | ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$k" $v }`;

/** The hint, indented for setup's report, for `platform` (`process.platform`, injected for tests). */
export const liveSuiteLines = (platform: string): readonly string[] => [
  '  live suites skip without services — to run them, in RAM:',
  '    docker compose -f docker/docker-compose.test.yml up -d --wait',
  platform === 'win32' ? `    ${POWERSHELL_LOAD}` : `    set -a; . ${TEST_SERVICES_ENV}; set +a`,
];
