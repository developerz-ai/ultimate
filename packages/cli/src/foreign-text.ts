// The one fence for foreign text an agent reads: a PR review body (`x pr review`) and a CI log
// (`x ci`) are both written by anyone who can comment or push, and rendered bare they arrive in the
// agent's context indistinguishable from this CLI's own output. A leaf, so both commands share it.

const BLOCK_OPEN = '<comment id=';
const BLOCK_CLOSE = '</comment>';

/**
 * The fence, as a READER would parse it rather than as this file spells it.
 *
 * Two literal `replaceAll`s were the whole neutralisation, and markup is not spelled one way:
 * `</comment >`, `</COMMENT>` and `< comment id=` all end or open a block for anything reading
 * tags, and none of the three matched. One pattern over `<`, an optional `/`, and whitespace
 * around a case-insensitive `comment` covers every spelling of the delimiter; the escape goes on
 * the `<`, so what the reviewer wrote after it survives byte for byte.
 */
const BLOCK_DELIMITER = /<(\s*\/?\s*comment\b)/gi;

/**
 * One comment body, fenced and labelled with the thread id it came from — `@ultimat3/ai`'s
 * `documentBlock` (`rag.ts`), applied to the other place foreign text enters an agent's context.
 * `x pr review` exists because an agent cannot read the GitHub web UI, and a review body is
 * written by anyone who can comment on the pull request: rendered as bare indented text it arrived
 * in that agent's context indistinguishable from the command's own output, which is prompt
 * injection with a shell attached.
 *
 * The fence is neutralised INSIDE the payload rather than deleted, so every word the reviewer
 * wrote still reads, and the label is stripped of the three characters that would end the
 * attribute. Influence only, and deliberately not sold as more: a fence tells a reader this text
 * is data, and it can never stop one that decides otherwise.
 */
export function commentBlock(id: string, lines: readonly string[]): readonly string[] {
  const label = id.replaceAll('"', "'").replaceAll('>', ')').replaceAll('<', '(');
  const body = lines.map((line) => line.replace(BLOCK_DELIMITER, '<\\$1'));
  return [`${BLOCK_OPEN}"${label}">`, ...body, BLOCK_CLOSE];
}
