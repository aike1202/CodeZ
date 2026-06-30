import { WidgetType, Decoration, MatchDecorator, ViewPlugin, EditorView, ViewUpdate } from '@codemirror/view'
import { createRoot, Root } from 'react-dom/client'
import React from 'react'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'

class PillWidget extends WidgetType {
  root?: Root;

  constructor(readonly name: string, readonly path: string, readonly isSkill: boolean) {
    super()
  }

  eq(other: PillWidget) {
    return other.name === this.name && other.path === this.path && other.isSkill === this.isSkill
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-pill-widget'

    const icon = document.createElement('span')
    icon.className = 'cm-pill-icon'
    icon.style.display = 'flex'
    icon.style.alignItems = 'center'
    icon.style.marginRight = '4px'

    if (this.isSkill) {
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`
    } else {
      this.root = createRoot(icon)
      const isDir = !this.name.includes('.')
      const iconElement = isDir 
        ? React.createElement(FolderIcon, { folderName: this.name, width: 14, height: 14 })
        : React.createElement(FileIcon, { fileName: this.name, width: 14, height: 14 })
      this.root.render(iconElement)
    }
    
    span.appendChild(icon)
    const textNode = document.createTextNode(this.name)
    span.appendChild(textNode)
    return span
  }

  destroy(dom: HTMLElement) {
    if (this.root) {
      setTimeout(() => this.root?.unmount(), 0)
    }
  }
}

const pillMatcher = new MatchDecorator({
  regexp: /\[(.*?)\]\((.*?)\)/g,
  decoration: (match) => {
    const name = match[1]
    const path = match[2]
    let isSkill = false
    let displayName = name
    if (name.startsWith('$')) {
      isSkill = true
      displayName = name.slice(1)
      if (displayName.length > 0) displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1)
    } else if (name.startsWith('/')) {
      isSkill = true
      displayName = name.slice(1)
      if (displayName.length > 0) displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1)
    } else if (name.startsWith('@')) {
      displayName = name.slice(1)
    }
    return Decoration.replace({
      widget: new PillWidget(displayName, path, isSkill)
    })
  }
})

export const pillDecoration = ViewPlugin.fromClass(
  class {
    placeholders: any
    constructor(view: EditorView) {
      this.placeholders = pillMatcher.createDeco(view)
    }
    update(update: ViewUpdate) {
      this.placeholders = pillMatcher.updateDeco(update, this.placeholders)
    }
  },
  {
    decorations: (instance) => instance.placeholders,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        return view.plugin(plugin)?.placeholders || Decoration.none
      })
  }
)
