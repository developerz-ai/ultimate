// One responsibility: WHERE a Chrome is installed, per platform — the ordered list `findChrome`
// probes when `CHROME_PATH` names none. Which binary wins and how it starts is `cdp-launch.ts`.

// why: a Windows candidate is spelled with `\` whatever OS computes the list (a test, or the
// Linux runner asserting it), and only node:path's win32 half joins that way. Bun has no path API.
import { win32 } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** What GitHub-hosted `ubuntu-latest` ships, which lets CI run the browser suite with no download. */
const LINUX: readonly string[] = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const set = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * Chrome under each root an installer uses — machine-wide 64- and 32-bit, then per-user — then
 * Edge, which is Chromium, speaks the same DevTools protocol and is on every Windows 10 and 11. A
 * root the environment does not name falls back to its fixed default; a per-user root has none, so
 * it is not guessed at.
 */
const windows = (env: Env): readonly string[] => {
  const programFiles = set(env['ProgramFiles']) ?? 'C:\\Program Files';
  const programFilesX86 = set(env['ProgramFiles(x86)']) ?? 'C:\\Program Files (x86)';
  const localAppData = set(env['LOCALAPPDATA']);
  const chromeRoots = [programFiles, programFilesX86, ...(localAppData ? [localAppData] : [])];
  return [
    ...chromeRoots.map((root) => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    // x86 first for Edge: it is where the Windows image installs it, 64-bit or not.
    ...[programFilesX86, programFiles].map((root) =>
      win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ),
  ];
};

const MAC_CHROME = 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** The app bundles' executables: system-wide, then the per-user `~/Applications` an admin-less install uses. */
const mac = (env: Env): readonly string[] => {
  const home = set(env['HOME']);
  return [
    `/${MAC_CHROME}`,
    ...(home ? [`${home}/${MAC_CHROME}`] : []),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
};

/**
 * Where a Chrome is on `platform`, in the order worth trying. Any platform that is neither Windows
 * nor macOS gets the Linux paths — the BSDs install to the same names when they install at all.
 */
export function chromeCandidates(platform: string, env: Env): readonly string[] {
  if (platform === 'win32') return windows(env);
  if (platform === 'darwin') return mac(env);
  return LINUX;
}
