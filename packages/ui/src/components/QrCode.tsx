// A QR code of one short value — a link's short URL, a join code — as static SVG from the
// pure-TypeScript encoder in `qr-encode.ts` / `qr-matrix.ts`. No QR library: a route's JS budget
// counts raw minified bytes, and one `<rect>` per dark module costs nothing to hydrate, so the
// server-rendered shell IS the code. Versions 1-3 only (42 bytes); longer is `X_UI_QR_CAPACITY`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './QrCode.module.scss';
import { encodeQr, quietZoneOf } from './qr-matrix';

export interface QrCodeProps {
  /** What the code encodes — a short URL, at most 42 UTF-8 bytes. Longer throws. */
  value: string;
  /** The accessible name, already translated — say what scanning it does, not "QR code". */
  label: string;
  /** Light modules on every side. Default 4, the minimum a scanner needs to find the finders. */
  quietZone?: number | undefined;
  class?: string | undefined;
}

export function QrCode(props: QrCodeProps): JSX.Element {
  const matrix = (): ReturnType<typeof encodeQr> => encodeQr(props.value);
  const quiet = (): number => quietZoneOf(props.quietZone);
  const dimension = (): number => matrix().size + quiet() * 2;
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${dimension()} ${dimension()}`}
      class={cx(styles['qr'], props.class)}
      shape-rendering="crispEdges"
    >
      <rect class={styles['ground']} x={0} y={0} width={dimension()} height={dimension()} />
      {matrix().modules.flatMap((row, rowIndex) =>
        row.map((dark, colIndex) =>
          dark ? (
            <rect
              class={styles['module']}
              x={quiet() + colIndex}
              y={quiet() + rowIndex}
              width={1}
              height={1}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
