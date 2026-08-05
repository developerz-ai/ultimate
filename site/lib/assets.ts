// Everything the build reads off disk and reshapes on the way out: source text, the inlined SCSS
// bundle, the inline theme script, and the static asset copy.

import { ROOT, STYLE_ORDER } from './config';

export async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/** SCSS here is nesting + custom properties only, so stripping `//` comments is a compile. */
export async function compileStyles(): Promise<string> {
  const parts: string[] = [];
  for (const name of STYLE_ORDER) {
    const src = await readText(`${ROOT}/styles/${name}.scss`);
    parts.push(
      src
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n'),
    );
  }
  return parts
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([{;:,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

export async function compileScript(): Promise<string> {
  const src = await readText(`${ROOT}/scripts/theme.js`);
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function copyDir(from: string, to: string): Promise<number> {
  let count = 0;
  for await (const entry of new Bun.Glob('**/*').scan({ cwd: from, onlyFiles: true })) {
    await Bun.write(`${to}/${entry}`, Bun.file(`${from}/${entry}`));
    count += 1;
  }
  return count;
}
