// The browser island `wiki/Realtime.md` promises: one live hook and nothing else. It is a real
// module rather than a string a test writes to a temp path, because module resolution is the thing
// under test — `@ultimat3/realtime`'s client entry must reach neither the bus nor the WAL decoder.
// Bundled by `realtime-browser-barrel.test.ts`; imported by nothing at runtime.

import { useLive } from '@ultimat3/realtime';

export const probeUseLive = useLive;
