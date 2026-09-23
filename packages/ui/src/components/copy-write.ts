// Single responsibility: one clipboard write, answered as a boolean. `CopyButton` claims "Copied"
// only on `true` — a missing clipboard (an insecure origin, an old browser, a harness) and a
// refused write (permission) are both a copy that did not happen, and neither may reject.

/** The one method used, structurally — `navigator.clipboard`, or a test's stand-in. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export async function writeToClipboard(
  value: string,
  clipboard: ClipboardWriter | undefined,
): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    // Refused: a permission prompt denied, or a document without focus. The button stays as it was.
    return false;
  }
}
