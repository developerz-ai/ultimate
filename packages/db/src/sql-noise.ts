// Single responsibility: blank everything in a SQL text that a keyword could legitimately hide
// inside, so a guard reading that text judges the operation and not the prose around it. Three
// guards now share it — the read-only client, the read-only query role and the destructive rail —
// and one wrong answer here is a hole in all three.
//
// It lives apart from all of them because `errors.ts` names the destructive rail's wording, the
// rail reads SQL text, and a text-scanner that reached back into a guard would put the error
// registry — which registers codes at module evaluation — inside an import cycle.

/**
 * Line comments, block comments, single-quoted literals, dollar-quoted bodies and quoted
 * identifiers, each replaced by whitespace. Blanking rather than deleting keeps offsets stable so
 * the reported statement still reads correctly.
 */
export function stripSqlNoise(text: string): string {
  return text
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, ' "" ');
}
