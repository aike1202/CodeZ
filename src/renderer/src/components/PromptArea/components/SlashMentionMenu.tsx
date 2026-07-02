import React from 'react'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'

interface SlashMentionMenuProps {
  activeToken: { type: 'slash' | 'at'; query: string } | null
  popupItems: any[]
  popupSelectedIndex: number
  setPopupSelectedIndex: (idx: number) => void
  handleSelectPopupItem: (item: any) => void
  filteredCommands: any[]
  filteredSkills: any[]
  filteredFiles: any[]
}

export default function SlashMentionMenu({
  activeToken,
  popupItems,
  popupSelectedIndex,
  setPopupSelectedIndex,
  handleSelectPopupItem,
  filteredCommands,
  filteredSkills,
  filteredFiles
}: SlashMentionMenuProps): React.ReactElement | null {
  if (!activeToken || popupItems.length === 0) {
    return null
  }

  return (
    <div className="prompt-slash-menu shadow-2xl">
      {activeToken.type === 'at' && (
        <>
          <div className="prompt-slash-section-header">文件 / 文件夹</div>
          {filteredFiles.map((file) => {
            const globalIdx = popupItems.findIndex((item) => item.path === file.path)
            return (
              <div
                key={file.path}
                className={`prompt-slash-item ${globalIdx === popupSelectedIndex ? 'is-selected' : ''}`}
                onClick={() => handleSelectPopupItem({ ...file, type: 'file' })}
                onMouseEnter={() => setPopupSelectedIndex(globalIdx)}
              >
                <span className="prompt-slash-file-icon">
                  {file.isDir ? (
                    <FolderIcon folderName={file.name} size={16} />
                  ) : (
                    <FileIcon fileName={file.name} size={16} />
                  )}
                </span>
                <div className="prompt-slash-item-content">
                  <span className="prompt-slash-title">{file.name}</span>
                  <span className="prompt-slash-desc">{file.path}</span>
                </div>
              </div>
            )
          })}
        </>
      )}

      {activeToken.type === 'slash' && filteredCommands.length > 0 && (
        <>
          <div className="prompt-slash-section-header">系统命令</div>
          {filteredCommands.map((cmd) => {
            const globalIdx = popupItems.findIndex(
              (item) => item.type === 'command' && item.name === cmd.name
            )
            return (
              <div
                key={cmd.name}
                className={`prompt-slash-item ${globalIdx === popupSelectedIndex ? 'is-selected' : ''}`}
                onClick={() => handleSelectPopupItem({ ...cmd, type: 'command' })}
                onMouseEnter={() => setPopupSelectedIndex(globalIdx)}
              >
                <div className="prompt-slash-item-content">
                  <span className="prompt-slash-title">/{cmd.name}</span>
                  <span className="prompt-slash-desc">{cmd.description}</span>
                </div>
              </div>
            )
          })}
        </>
      )}

      {activeToken.type === 'slash' && filteredSkills.length > 0 && (
        <>
          <div className="prompt-slash-section-header">技能</div>
          {filteredSkills.map((skill) => {
            const globalIdx = popupItems.findIndex(
              (item) => item.type === 'skill' && item.id === skill.id
            )
            return (
              <div
                key={skill.id}
                className={`prompt-slash-item ${globalIdx === popupSelectedIndex ? 'is-selected' : ''}`}
                onClick={() => handleSelectPopupItem({ ...skill, type: 'skill' })}
                onMouseEnter={() => setPopupSelectedIndex(globalIdx)}
              >
                <div className="prompt-slash-item-content">
                  <span className="prompt-slash-skill-title">{skill.name}</span>
                  <span className="prompt-slash-desc">{skill.description || skill.displayName}</span>
                </div>
              </div>
            )
          })}
        </>
      )}

      <div className="prompt-slash-menu-footer">
        <span className="prompt-slash-footer-icon">ⓘ</span>
        <span>{activeToken.type === 'slash' ? '输入内容以搜索命令或者技能' : '输入内容以搜索文件'}</span>
      </div>
    </div>
  )
}
