// The rules behind `FileInput` and `Dropzone`, with no renderer: which files a control accepts,
// why it turned one away, and how a byte count and a ratio become something a human reads.
// Kept here because a `.tsx` holds markup and never a rule — and because "did it reject the
// right file" is the question a component test could never ask without a DOM.

/** Why a file was turned away. A reason, not a message: the caller owns the translated string. */
export type FileRejectionReason = 'type' | 'size' | 'count';

/** The three fields of a `File` these rules read. Structural, so a test needs no DOM. */
export interface FileCandidate {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface FileRejection<TFile extends FileCandidate> {
  readonly file: TFile;
  readonly reason: FileRejectionReason;
}

export interface FileSelection<TFile extends FileCandidate> {
  readonly accepted: readonly TFile[];
  /** Never dropped silently: a file that vanished with no explanation reads as a broken control. */
  readonly rejected: readonly FileRejection<TFile>[];
}

export interface FileSelectionLimits {
  /** The `accept` attribute's own grammar: `.png`, `image/png`, `image/*`, comma-separated. */
  readonly accept?: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxFiles?: number | undefined;
}

/**
 * A file whose type the browser could not guess arrives with `type: ''`, and an empty type
 * matches no MIME pattern here — not even a wildcard one — because the alternative is a control
 * that quietly widens itself for exactly the files least worth trusting. The server sniffs the
 * bytes anyway; this is the cheap half, and the cheap half fails closed too.
 */
export function acceptMatches(accept: string, file: FileCandidate): boolean {
  const patterns = accept
    .split(',')
    .map((one) => one.trim().toLowerCase())
    .filter((one) => one !== '');
  if (patterns.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return type !== '' && type.startsWith(pattern.slice(0, -1));
    return type !== '' && type === pattern;
  });
}

/** Partition a drop or a picker's `files` into what the control takes and what it refused. */
export function selectFiles<TFile extends FileCandidate>(
  files: readonly TFile[],
  limits: FileSelectionLimits = {},
): FileSelection<TFile> {
  const accepted: TFile[] = [];
  const rejected: FileRejection<TFile>[] = [];
  for (const file of files) {
    if (limits.accept !== undefined && !acceptMatches(limits.accept, file)) {
      rejected.push({ file, reason: 'type' });
    } else if (limits.maxBytes !== undefined && file.size > limits.maxBytes) {
      rejected.push({ file, reason: 'size' });
    } else if (limits.maxFiles !== undefined && accepted.length >= limits.maxFiles) {
      rejected.push({ file, reason: 'count' });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

/** 0..100, integer. A ratio outside the range, or `NaN`, is 0 — never a bar that renders `NaN%`. */
export function progressPercent(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}

// Decimal, not binary: `Intl`'s byte units ARE decimal (kB = 1000 B), so dividing by 1024 and
// labelling the result "kB" through `Intl` prints a number that disagrees with its own unit.
const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
const BYTE_STEP = 1000;

/** A size a human reads, in the viewer's locale — never a hand-built "1.2 MB" string. */
export function formatFileSize(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safe;
  let index = 0;
  while (value >= BYTE_STEP && index < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    index += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[index] ?? 'byte',
    unitDisplay: 'short',
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value);
}

/** The one field of the `<input type="file">` a drop has to write. Structural, so a test needs no DOM. */
export interface FileTarget {
  files: FileList | null;
}

/** Builds the `FileList` an input's `files` accepts — the one constructor the DOM offers for it. */
export type FileListOf<TFile extends FileCandidate> = (files: readonly TFile[]) => FileList;

function dataTransferList<TFile extends FileCandidate>(files: readonly TFile[]): FileList {
  const transfer = new DataTransfer();
  for (const one of files) transfer.items.add(one as unknown as File);
  return transfer.files;
}

/**
 * Make the real `<input>` hold exactly the files the control ACCEPTED, so the form posts what the
 * control showed and nothing it refused.
 *
 * A drop never reaches the input on its own: without this a `<Dropzone name="avatar" required>`
 * shows the accepted file and then refuses to submit. And handing it the whole drop posted the
 * files `accept` / `maxBytes` / `maxFiles` turned away — `accept` is a hint to the picker, never a
 * filter on `files`. So a `drop` with something accepted is adopted as the accepted list, and a
 * drop with nothing accepted leaves an earlier pick alone, as a refused drop should. A `pick`
 * already set `files` itself; it is narrowed only when it refused something — to an empty list if
 * it refused everything, because the refused file is the one the form would otherwise post. A list
 * is BUILT (`listOf`, a `DataTransfer` in a browser) only when something was refused.
 */
export function adoptAcceptedFiles<TFile extends FileCandidate>(
  input: FileTarget | undefined,
  offered: FileList | null | undefined,
  selection: FileSelection<TFile>,
  origin: 'drop' | 'pick',
  listOf: FileListOf<TFile> = dataTransferList,
): void {
  if (input === undefined) return;
  if (origin === 'drop' && selection.accepted.length === 0) return;
  if (selection.rejected.length > 0) {
    input.files = listOf(selection.accepted);
  } else if (origin === 'drop' && offered !== null && offered !== undefined) {
    // Nothing refused: the drop's own list, which needs no constructor at all.
    input.files = offered;
  }
}
