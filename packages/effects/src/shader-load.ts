// A program and the mount that draws it, fetched together and lazily: only an entry that can draw
// a shader names this module, so a CSS or Canvas2D entry never carries the WebGL2 mount — not even
// in a one-island build, where a bundler inlines every dynamic `import()` it can reach.

import type { mountShader, ShaderProgram } from './shader-mount';

export interface ShaderLoad {
  readonly program: ShaderProgram;
  readonly mount: typeof mountShader;
}

export function loadShader(program: Promise<ShaderProgram>): Promise<ShaderLoad> {
  return Promise.all([program, import('./shader-mount')]).then(([loaded, module]) => ({
    program: loaded,
    mount: module.mountShader,
  }));
}
