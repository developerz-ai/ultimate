// One dynamic `import()` per preset, each a literal path, so a splitting bundler emits each
// preset's GLSL as its own chunk and an island fetches only the one it draws.

import type { Rgb } from '../palette';
import type { ShaderProgram } from '../shader-mount';
import type { ShaderPreset } from './shader-background-view';

export type ProgramFactory = (colours: () => readonly Rgb[]) => ShaderProgram;

export function loadPreset(preset: ShaderPreset): Promise<ProgramFactory> {
  switch (preset) {
    case 'mesh':
      return import('./presets/mesh').then((module) => module.meshProgram);
    case 'grain':
      return import('./presets/grain').then((module) => module.grainProgram);
    case 'dots':
      return import('./presets/dots').then((module) => module.dotsProgram);
  }
}
