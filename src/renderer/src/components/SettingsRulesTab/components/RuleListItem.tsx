import React from 'react'
import { IconMessage, IconTrash } from '../../Icons'
import type { RuleFile } from '@shared/types/rules'
import Switch from '../../ui/Switch'

interface RuleListItemProps {
  rule: RuleFile
  activeTabId: string | null
  inlineEditId: string | null
  inlineEditValue: string
  setInlineEditValue: (val: string) => void
  commitRename: () => void
  handleSelectRule: (rule: RuleFile) => void
  startRename: (rule: RuleFile) => void
  handleToggleRule: (rule: RuleFile, enabled: boolean) => void
  handleDeleteRule: (rule: RuleFile) => void
}

export function RuleListItem({
  rule,
  activeTabId,
  inlineEditId,
  inlineEditValue,
  setInlineEditValue,
  commitRename,
  handleSelectRule,
  startRename,
  handleToggleRule,
  handleDeleteRule
}: RuleListItemProps): React.ReactElement {
  const isEditing = inlineEditId === rule.path

  return (
    <div
      key={rule.path}
      className={`rule-item ${activeTabId === rule.path ? 'active' : ''}`}
      onClick={() => {
        if (!isEditing) handleSelectRule(rule)
      }}
      onDoubleClick={() => startRename(rule)}
    >
      <IconMessage className="shrink-0" style={{ marginRight: 8, opacity: 0.7 }} />
      {isEditing ? (
        <input
          autoFocus
          value={inlineEditValue}
          onChange={(e) => setInlineEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => e.key === 'Enter' && commitRename()}
          className="inline-rename-input"
          placeholder="输入文件名..."
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid var(--accent-primary)',
            color: 'var(--text-primary)',
            outline: 'none',
            padding: '2px 4px',
            borderRadius: 4,
            fontSize: 13
          }}
        />
      ) : (
        <>
          <span className="truncate" style={{ flex: 1 }}>
            {rule.filename}
          </span>
          <div className="rule-item-actions">
            <button
              className="rule-item-trash-btn"
              onClick={(e) => {
                e.stopPropagation()
                handleDeleteRule(rule)
              }}
              title="删除规则"
            >
              <IconTrash />
            </button>
            <div onClick={(e) => e.stopPropagation()}>
              <Switch
                checked={rule.enabled !== false}
                onChange={(checked) => handleToggleRule(rule, checked)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
