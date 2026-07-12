import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

class PromptPredictionWidget extends WidgetType {
  constructor(private readonly suggestion: string) {
    super()
  }

  eq(other: PromptPredictionWidget): boolean {
    return other.suggestion === this.suggestion
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-prompt-prediction'
    element.textContent = this.suggestion
    element.setAttribute('aria-label', `输入建议：${this.suggestion}`)
    return element
  }

  ignoreEvent(): boolean {
    return true
  }
}

export function promptPredictionExtension(suggestion: string): Extension {
  if (!suggestion) return []

  return EditorView.decorations.compute(['doc', 'selection'], (state) => {
    const selection = state.selection.main
    if (!selection.empty || selection.head !== state.doc.length) {
      return Decoration.none
    }

    return Decoration.set([
      Decoration.widget({
        widget: new PromptPredictionWidget(suggestion),
        side: 1
      }).range(state.doc.length)
    ])
  })
}
