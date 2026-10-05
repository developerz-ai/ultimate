// Single responsibility: byte-exact image fixtures produced by an INDEPENDENT encoder
// (Pillow 10.2 and ffmpeg), plus the pixels they must decode to. A codec that only
// round-trips against itself proves nothing — these bytes are the outside reference, so a
// decoder bug shows up as a pixel mismatch rather than a mutually agreed hallucination.

export interface ImageFixture {
  /** The encoded file, base64. */
  readonly base64: string;
  readonly width: number;
  readonly height: number;
  /** Expected RGBA decode, row-major. Omitted for probe-only and lossy fixtures. */
  readonly pixels?: readonly number[] | undefined;
}

export const fixtureBytes = (fixture: ImageFixture): Uint8Array =>
  Uint8Array.from(atob(fixture.base64), (c) => c.charCodeAt(0));

/** Truecolour + alpha (PNG colour type 6), including fully transparent and premature zeros. */
export const PNG_RGBA_4X4: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAQUlEQVR4nAXBKQGAABAAweU5Po1GE4I4hEBeCpIQ' +
    'gjjoM8sMgIJIgqC6rNv+3qdN2/VkpoqookREVFUd1/PN0zj84AIej7U060EAAAAASUVORK5CYII=',
  width: 4,
  height: 4,
  pixels: [
    0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255, 10, 20, 30, 40,
    200, 150, 100, 255, 1, 2, 3, 4, 128, 128, 128, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0,
    255, 255, 5, 5, 5, 5, 250, 250, 250, 250, 60, 120, 180, 240, 9, 8, 7, 6,
  ],
};

/** Truecolour, no alpha (colour type 2) — alpha must be synthesised as 255. */
export const PNG_RGB_3X2: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAF0lEQVR4nGP4z8DAAMFcInInUowYGBgANh8EmGKC' +
    'N2kAAAAASUVORK5CYII=',
  width: 3,
  height: 2,
  pixels: [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255, 200, 100, 50, 255, 0, 0, 0,
    255,
  ],
};

/** Greyscale (colour type 0) — one channel replicated across RGB. */
export const PNG_GRAY_2X2: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR4nGNgCGVY9R8AA60B/2f7ygkAAAAASUVO' +
    'RK5CYII=',
  width: 2,
  height: 2,
  pixels: [0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255],
};

/** Indexed colour (type 3) with a `tRNS` alpha table — the entry PNG readers forget. */
export const PNG_PALETTE_4X1: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAMAAADO4v//AAADAFBMVEX/AAAA/wAAAP///wAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAX3fWLAAAABHRSTlP/gAD/oaGUZgAAAA1JREFUeJxjYGBkYgYAAA8AB4SOmW0AAAAA' +
    'SUVORK5CYII=',
  width: 4,
  height: 1,
  pixels: [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 0, 255],
};

/** Greyscale + alpha (colour type 4). */
export const PNG_GRAY_ALPHA_2X2: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAAEklEQVR4nGNk+N/QyHCC4b8DABPwBAkrfI8bAAAA' +
    'AElFTkSuQmCC',
  width: 2,
  height: 2,
  pixels: [0, 0, 0, 255, 128, 128, 128, 128, 200, 200, 200, 0, 255, 255, 255, 64],
};

/** 16 bits per channel — must be reduced to 8 by taking the high byte. */
export const PNG_GRAY16_2X2: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACEAAAAAAHTY67AAAAEklEQVR4nGNgYHBgYGhg+P8fAAbHAr89RY6RAAAA' +
    'AElFTkSuQmCC',
  width: 2,
  height: 2,
  pixels: [0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255],
};

/** Big enough that Pillow picks a different row filter per scanline — all five must work. */
export const PNG_GRADIENT_32X24: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAuklEQVR4nLXSyw6DIBCF4WNrr/aiaNHamL7/W3aB' +
    'GFDEgQ7JtxjGxR/UDMAppRwFgCydKbBLxAzsU5gFcnbLwIGXM3BktBZg+1E9gTMLf+Dyv83ANdagBkqgCNHPNsTA' +
    'jaBz7umB+zrpeRoUeCw0rqUlNPA01PbRLSJQAiUg9LAhLlDRRQQEUAGC5hsaqPUNBFB7DWoICjTGK1KBxuVjHqO/' +
    'wRR42frZhh6Q6wGpvY15xHIDCbRAB7RLPwPnHDcTUr+XAAAAAElFTkSuQmCC',
  width: 32,
  height: 24,
};

/** The exact source of `PNG_GRADIENT_32X24` and the JPEG fixtures, as a formula. */
export const gradientPixel = (x: number, y: number): readonly [number, number, number] => [
  (x * 7) % 256,
  (y * 11) % 256,
  (x * y) % 256,
];

/**
 * A genuine Adam7 interlaced PNG (written by ImageMagick — Pillow's writer silently ignores
 * `interlace=True`, which is why this one is not generated with the others). The pipeline
 * refuses it with a coded error rather than garbling it.
 */
export const PNG_INTERLACED_8X8: ImageFixture = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAAE8ahlKAAAAS0lEQVQI12NgYGBgqGFQYWQoUalhUGGwYxDaxWDG' +
    'wlCiwsCgwshgJWTHAEUQMSEIYpRn4ESSsRKCy+DmMDLIcsozYEEQVZyYiHQJAE1EC4Be7arJAAAAAElFTkSuQmCC',
  width: 8,
  height: 8,
};

/** Baseline JPEG, 4:4:4, quality 95 — the closest a lossy codec gets to exact. */
export const JPEG_444_16X16: ImageFixture = {
  base64:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJ' +
    'BwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoK' +
    'CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAQABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA' +
    'AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk' +
    'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT' +
    'lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA' +
    'HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh' +
    'cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp' +
    'anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
    '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD83/gx+yH/AKr/AIlfp/BRg8Z5h4eeIfwe+fW3wX/ZDz5X/Er9' +
    'P4K+qweM21P7r8PPEP4PfPpT4L/sh48r/iV+n8FfleDxm2p/hT4eeIfwe+fW3wY/ZD/1X/Er9P4K+qweM8z+6/Dz' +
    'xD+D3z//2Q==',
  width: 16,
  height: 16,
};

/** Baseline JPEG, 4:2:0 — chroma is half resolution and must be upsampled. */
export const JPEG_420_16X16: ImageFixture = {
  base64:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4R' +
    'DgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' +
    'FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA' +
    'AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk' +
    'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT' +
    'lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA' +
    'HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh' +
    'cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp' +
    'anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
    '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4/wDBfwh/1f7j9K958F/CH/V/uP0r2PwX8If9X+4/SvefBfwh' +
    '/wBX+4/SjB4zbUPDzxD+D3z/2Q==',
  width: 16,
  height: 16,
};

/** The exact source of the 16x16 JPEG fixtures, as a formula. */
export const jpegPixel = (x: number, y: number): readonly [number, number, number] => [
  (x * 16) % 256,
  (y * 16) % 256,
  ((x + y) * 8) % 256,
];

/** Odd dimensions with 4:2:0: the last MCU column and row are padded and must be cropped. */
export const JPEG_420_ODD_33X17: ImageFixture = {
  base64:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwMDAgQDAwMEBAQFBgoGBgUFBgwICQcKDgwPDg4MDQ0PERYTDxAV' +
    'EQ0NExoTFRcYGRkZDxIbHRsYHRYYGRj/2wBDAQQEBAYFBgsGBgsYEA0QGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY' +
    'GBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBj/wAARCAARACEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA' +
    'AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk' +
    'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT' +
    'lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA' +
    'HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh' +
    'cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp' +
    'anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
    '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5Q0fwT5u39z+ld1pvw/iSISTIqL6nvXp/h3weiW/nSRfKoyeO' +
    'tdhpvg/di6uot8jcJGBjPsPQf561rgMVg4YSnWrQU5zV9X7sY931d3oktZO6Tvv4XDfG0nJJTPLNO8D2h4hs5JTx' +
    'g7dqn+v6VR+JHgq2Hgu0AtIUYX6AgkyEfu5OwGRX0dZeEGLhZ4ix2gmJDtRQOef59/5VQ+InhLb4LtDs+UXyZ8v5' +
    'F/1cnAPU9OlZ0M4w6xkI8kY66+7HTfpZyVutpuS+0lu/1vNuNH/q7ivf+x380fHP/CERf8+8H/fl6K96/wCEIi/5' +
    '94P+/L0V9J/bf/Til/4Gfz7/AK6f32eh6N/yA3/4D/6EK7LTv+Qlb/8AXIfzNFFfmMP4OE/wUv8A0uofC8M7/f8A' +
    'kjpNG/5Ab/8AAf8A0IVB8RP+QBp3/XxH/wCgy0UV8/k/8bAf4aX/AKXUP2DOf+Sexv8Ahf6HjNFFFfmh+Hn/2Q==',
  width: 33,
  height: 17,
};

/** The exact source of `JPEG_420_ODD_33X17`, as a formula. */
export const oddJpegPixel = (x: number, y: number): readonly [number, number, number] => [
  (x * 9) % 256,
  (y * 13) % 256,
  (x * y * 3) % 256,
];

/** Single-component (greyscale) JPEG. */
export const JPEG_GRAY_16X16: ImageFixture = {
  base64:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsO' +
    'CwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAAQABABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI' +
    'CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcY' +
    'GRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKj' +
    'pKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APzK' +
    '8P8Ah/8AtXb8mc+1el+H/gt/au3/AETOf9mj4LeH/wC1fI+TOcdq+9fgt8Fv7V8j/RM5x/DX/9k=',
  width: 16,
  height: 16,
};

/** Progressive JPEG — refused with a coded error, never decoded as noise. */
export const JPEG_PROGRESSIVE_16X16: ImageFixture = {
  base64:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4R' +
    'DgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' +
    'FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAA' +
    'Bgf/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGPvGTw/8QAFhAAAwAAAAAAAAAAAAAAAAAAAAQF' +
    '/9oACAEBAAEFAkpAlIEpAlIP/8QAFxEBAAMAAAAAAAAAAAAAAAAABgAhMf/aAAgBAwEBPwE8hy5//8QAFREBAQAA' +
    'AAAAAAAAAAAAAAAAAwD/2gAIAQIBAT8BFr//xAAWEAADAAAAAAAAAAAAAAAAAAAAASH/2gAIAQEABj8CUFBQUP/E' +
    'ABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8hCqq//9oADAMBAAIAAwAAABBT/8QAFBEBAAAAAAAAAAAAAAAA' +
    'AAAAAP/aAAgBAwEBPxB//8QAFhEAAwAAAAAAAAAAAAAAAAAAACEx/9oACAECAQE/EIM//8QAFRABAQAAAAAAAAAA' +
    'AAAAAAAAAPH/2gAIAQEAAT8QgoKCgv/Z',
  width: 16,
  height: 16,
};

/** Probe-only: GIF87a/89a header. */
export const GIF_5X7: ImageFixture = {
  base64: 'R0lGODdhBQAHAIEAAAAAAAAAAAAAAAAAACwAAAAABQAHAAAIDAABCBxIsKDBgwcDAgA7',
  width: 5,
  height: 7,
};

/** Probe-only: lossy VP8 inside RIFF/WEBP. */
export const WEBP_9X11: ImageFixture = {
  base64: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoJAAsAAUAmJaQAA3AA/v02aAA=',
  width: 9,
  height: 11,
};

/** Probe-only: AVIF, dimensions read from the `ispe` property box. */
export const AVIF_12X16: ImageFixture = {
  base64:
    'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAA' +
    'AAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEA' +
    'AAAiAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNw' +
    'ZQAAAAAAAAAMAAAAEAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lw' +
    'bWEAAAAAAAAAAQABBAECgwQAAAAqbWRhdAoKAAAAAZ35//MAgDIUEADAAAACgAAAAKmObLaqsca2hUA=',
  width: 12,
  height: 16,
};

/** Probe-only: SVG is vector — it has a declared box but no raster to decode. */
export const SVG_120X45: ImageFixture = {
  base64:
    'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNDUiIHZp' +
    'ZXdCb3g9IjAgMCAxMjAgNDUiPjwvc3ZnPg==',
  width: 120,
  height: 45,
};
