// Single responsibility: base64 over UTF-8 bytes. RFC 2047 encoded words and SMTP AUTH need the
// same operation, and `btoa` alone throws above code point 0xFF — so the string is encoded to
// bytes first and each byte re-packed as one Latin-1 char, which is what `btoa` actually takes.

export function base64Utf8(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
