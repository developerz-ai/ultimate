// A path read off the repository being scanned, made safe to ride in the `#` comment of a `fix:`
// line. One definition: every finding that names a scanned file in its fix writes it through this.

/**
 * Control characters, `\u00xx`-escaped. The path is a value read off the repository being scanned,
 * and it rides in a `#` comment: a directory holding a NEWLINE ends that comment, so everything
 * after it is a second command in a line whose whole purpose is to be pasted into a shell.
 * Escaped rather than deleted, because the comment still has to name the file the reader owns.
 */
export const commentSafe = (path: string): string =>
  [...path]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : char;
    })
    .join('');
