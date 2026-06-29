import React, { useEffect, useState } from 'react'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import { IconBook, IconAdd, IconTrash } from './Icons'
import { useRulesStore } from '../stores/rulesStore'
import type { RuleFile, RuleScope } from '@shared/types/rules'
import './SettingsRulesTab.css'

export default function SettingsRulesTab(): React.ReactElement {
  const rules = useRulesStore(s => s.rules)
  const loadRules = useRulesStore(s => s.loadRules)
  const saveRule = useRulesStore(s => s.saveRule)
  const deleteRule = useRulesStore(s => s.deleteRule)
  
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  
  // Local state for the editor
  const [editingRule, setEditingRule] = useState<Partial<RuleFile> | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    loadRules()
  }, [])

  const globalRules = rules.filter(r => r.scope === 'global')
  const workspaceRules = rules.filter(r => r.scope === 'workspace')

  const handleSelectRule = (rule: RuleFile) => {
    setActiveTabId(rule.path)
    setEditingRule({ ...rule })
  }

  const handleNewRule = (scope: RuleScope) => {
    setActiveTabId('new')
    setEditingRule({
      scope,
      filename: '',
      description: '',
      globs: '',
      alwaysApply: false,
      content: ''
    })
  }

  const handleSave = async () => {
    if (!editingRule || !editingRule.filename) return
    setIsSaving(true)
    try {
      const success = await saveRule(editingRule as RuleFile)
      if (success) {
        // If it was new, we might need to select it by its new path, 
        // but since we don't have the exact path returned easily, we just reload
        if (activeTabId === 'new') {
          setActiveTabId(null)
          setEditingRule(null)
        }
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editingRule || !editingRule.path) return
    if (confirm(`确定要删除规则 ${editingRule.filename} 吗？`)) {
      await deleteRule(editingRule.path)
      setActiveTabId(null)
      setEditingRule(null)
    }
  }

  return (
    <Flex className="settings-content-wrapper">
      {/* 左侧 - 规则列表 */}
      <Stack className="settings-provider-sidebar">
        <div className="settings-provider-header">
          <h1 className="settings-provider-title">规则设置</h1>
          <p className="settings-provider-desc">管理全局和当前项目的 Agent 规则，指导 AI 如何编写代码。</p>
        </div>
        
        <Stack className="settings-provider-list-container">
          {/* 全局规则 */}
          <div className="settings-provider-group-label">🌐 全局规则 (Global)</div>
          <Stack gap={1} style={{ marginBottom: 16 }}>
            {globalRules.map((r) => (
              <Flex
                key={r.path}
                align="center"
                className={`settings-provider-item ${activeTabId === r.path ? 'active' : 'inactive'}`}
                onClick={() => handleSelectRule(r)}
              >
                <IconBook className="btn-icon shrink-0" style={{ marginRight: 8 }}/>
                <span className="truncate">{r.filename}</span>
              </Flex>
            ))}
            <Flex
              align="center"
              className="settings-provider-item inactive"
              onClick={() => handleNewRule('global')}
              style={{ marginTop: 4, color: 'var(--text-secondary)' }}
            >
              <IconAdd className="shrink-0" style={{ marginRight: 8 }}/>
              <span>添加全局规则</span>
            </Flex>
          </Stack>

          {/* 项目规则 */}
          <div className="settings-provider-group-label">📁 当前项目规则 (Workspace)</div>
          <Stack gap={1}>
            {workspaceRules.map((r) => (
              <Flex
                key={r.path}
                align="center"
                className={`settings-provider-item ${activeTabId === r.path ? 'active' : 'inactive'}`}
                onClick={() => handleSelectRule(r)}
              >
                <IconBook className="btn-icon shrink-0" style={{ marginRight: 8 }}/>
                <span className="truncate">{r.filename}</span>
              </Flex>
            ))}
            <Flex
              align="center"
              className="settings-provider-item inactive"
              onClick={() => handleNewRule('workspace')}
              style={{ marginTop: 4, color: 'var(--text-secondary)' }}
            >
              <IconAdd className="shrink-0" style={{ marginRight: 8 }}/>
              <span>添加项目规则</span>
            </Flex>
          </Stack>
        </Stack>
      </Stack>

      {/* 右侧 - 编辑区 */}
      {editingRule ? (
        <Flex direction="col" className="settings-panel-container" style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
          <Flex align="center" justify="between" style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
              {activeTabId === 'new' ? '新建规则' : '编辑规则'}
            </h2>
            <Flex gap={2}>
              {activeTabId !== 'new' && (
                <button 
                  className="btn btn-danger" 
                  onClick={handleDelete}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <IconTrash /> 删除
                </button>
              )}
              <button 
                className="btn btn-primary" 
                onClick={handleSave} 
                disabled={!editingRule.filename || isSaving}
              >
                {isSaving ? '保存中...' : '保存'}
              </button>
            </Flex>
          </Flex>

          <Stack gap={4}>
            {/* Meta data form */}
            <div className="form-group">
              <label>文件名 (File Name)</label>
              <input 
                type="text" 
                className="input" 
                placeholder="例如: react-style.md"
                value={editingRule.filename || ''}
                onChange={e => setEditingRule({ ...editingRule, filename: e.target.value })}
                disabled={activeTabId !== 'new'} // cannot rename existing files easily via this UI yet
              />
              <span className="help-text">推荐使用 .md 后缀。如果填入 AGENTS.md 或 .clinerules 则会存放在根目录。</span>
            </div>

            <div className="form-group">
              <label>描述 (Description)</label>
              <input 
                type="text" 
                className="input" 
                placeholder="这条规则的作用是什么？"
                value={editingRule.description || ''}
                onChange={e => setEditingRule({ ...editingRule, description: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>匹配路径 (Globs)</label>
              <input 
                type="text" 
                className="input" 
                placeholder="例如: src/**/*.tsx"
                value={editingRule.globs || ''}
                onChange={e => setEditingRule({ ...editingRule, globs: e.target.value })}
              />
            </div>

            <div className="form-group checkbox-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={!!editingRule.alwaysApply}
                  onChange={e => setEditingRule({ ...editingRule, alwaysApply: e.target.checked })}
                />
                总是生效 (Always Apply)
              </label>
            </div>

            <div className="form-group" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <label>规则内容 (Markdown)</label>
              <textarea 
                className="input rules-textarea" 
                placeholder="# 编写你的规则..."
                value={editingRule.content || ''}
                onChange={e => setEditingRule({ ...editingRule, content: e.target.value })}
                style={{ flex: 1, minHeight: 300, fontFamily: 'monospace', resize: 'vertical' }}
              />
            </div>
          </Stack>
        </Flex>
      ) : (
        <Flex align="center" justify="center" className="settings-empty-pane">
          请选择左侧的一条规则或新建一条规则
        </Flex>
      )}
    </Flex>
  )
}
