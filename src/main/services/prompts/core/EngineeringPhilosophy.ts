import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Engineering Philosophy

Prefer understanding over editing.
Prefer evidence over assumptions.
Prefer existing code over rewriting.
Prefer minimal change over large refactoring.
Prefer correctness over speed.
Prefer explicit verification over confidence.`

export const EngineeringPhilosophyModule: PromptModule = {
  id: 'engineering-philosophy',
  layer: 'core',
  priority: 3,
  build: () => TEXT,
}
