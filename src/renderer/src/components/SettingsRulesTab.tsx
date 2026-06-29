import React, { useEffect, useState } from 'react'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import { IconAdd, IconTrash, IconFolder, IconChevron, IconMessagePlus, IconMoreHorizontal, IconMessage, IconEdit } from './Icons'
import { useRulesStore } from '../stores/rulesStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { RuleFile, RuleScope } from '@shared/types/rules'
import MarkdownEditor from './ui/MarkdownEditor'
import './SettingsRulesTab.css'

export default function SettingsRulesTab(): React.ReactElement {
  const rules = useRulesStore(s => s.rules)
  const loadRules = useRulesStore(s => s.loadRules)
  const saveRule = useRulesStore(s => s.saveRule)
  const deleteRule = useRulesStore(s => s.deleteRule)
  const renameRule = useRulesStore(s => s.renameRule)
  
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  
  // Local state for the editor
  const [editingRule, setEditingRule] = useState<Partial<RuleFile> | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineEditValue, setInlineEditValue] = useState('')

  useEffect(() => {
    loadRules()
  }, [])

  const globalRules = rules.filter(r => r.scope === 'global')
  const workspaceRules = rules.filter(r => r.scope === 'workspace')

  const handleSelectRule = (rule: RuleFile) => {
    // If we are currently inline editing something else, commit it first
    if (inlineEditId && inlineEditId !== rule.path) {
      commitRename()
    }
    setActiveTabId(rule.path)
    setEditingRule({ ...rule })
  }

  const handleNewRule = (scope: RuleScope, projectId?: string) => {
    if (inlineEditId) commitRename()
    
    setActiveTabId('new')
    setEditingRule({
      scope,
      filename: '',
      content: '',
      projectId
    })
    setInlineEditId('new')
    setInlineEditValue('')
    
    if (projectId && !expandedProjects.has(projectId)) {
      setExpandedProjects(prev => new Set(prev).add(projectId))
    }
  }

  const startRename = (rule: RuleFile) => {
    setInlineEditId(rule.path)
    setInlineEditValue(rule.filename)
  }

  const commitRename = async () => {
    if (!inlineEditId) return
    const newName = inlineEditValue.trim()
    
    if (inlineEditId === 'new') {
      if (newName) {
        setEditingRule(prev => prev ? { ...prev, filename: newName } : null)
      } else {
        // If empty name on new rule, cancel creation
        setActiveTabId(null)
        setEditingRule(null)
      }
      setInlineEditId(null)
      return
    }

    if (newName) {
      const rule = rules.find(r => r.path === inlineEditId)
      if (rule && rule.filename !== newName) {
        await renameRule(rule.path, newName, rule.projectId, rule.scope)
        if (activeTabId === rule.path && editingRule) {
          setEditingRule({ ...editingRule, filename: newName })
        }
      }
    }
    setInlineEditId(null)
  }

  const toggleProject = (projectId: string) => {
    const next = new Set(expandedProjects)
    if (next.has(projectId)) {
      next.delete(projectId)
    } else {
      next.add(projectId)
    }
    setExpandedProjects(next)
  }

  const handleSave = async () => {
    if (!editingRule || !editingRule.filename) return
    setIsSaving(true)
    try {
      const success = await saveRule(editingRule as RuleFile)
      if (success) {
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

  const recentProjects = useWorkspaceStore(s => s.recentProjects)

  // Group workspace rules by projectId
  const workspaceRulesGrouped: Record<string, RuleFile[]> = {}
  workspaceRules.forEach(r => {
    if (r.projectId) {
      if (!workspaceRulesGrouped[r.projectId]) workspaceRulesGrouped[r.projectId] = []
      workspaceRulesGrouped[r.projectId].push(r)
    }
  })

  // Expand all projects by default when loaded
  useEffect(() => {
    if (recentProjects.length > 0 && expandedProjects.size === 0) {
      setExpandedProjects(new Set(recentProjects.map(p => p.id)))
    }
  }, [recentProjects])

  const renderInlineInput = () => (
    <input 
      autoFocus
      value={inlineEditValue}
      onChange={e => setInlineEditValue(e.target.value)}
      onBlur={commitRename}
      onKeyDown={e => e.key === 'Enter' && commitRename()}
      className="inline-rename-input"
      placeholder="输入文件名..."
      style={{ 
        flex: 1, background: 'transparent', border: '1px solid var(--accent-primary)', 
        color: 'var(--text-primary)', outline: 'none', padding: '2px 4px', borderRadius: 4, fontSize: 13
      }}
    />
  )

  const renderRuleItem = (r: RuleFile) => {
    const isEditing = inlineEditId === r.path
    return (
      <div
        key={r.path}
        className={`rule-item ${activeTabId === r.path ? 'active' : ''}`}
        onClick={() => { if (!isEditing) handleSelectRule(r) }}
        onDoubleClick={() => startRename(r)}
      >
        <IconMessage className="shrink-0" style={{ marginRight: 8, opacity: 0.7 }}/>
        {isEditing ? (
          renderInlineInput()
        ) : (
          <span className="truncate" style={{ flex: 1 }}>{r.filename}</span>
        )}
      </div>
    )
  }

  const renderNewRulePlaceholder = (scope: RuleScope, projectId?: string) => {
    if (activeTabId !== 'new' || editingRule?.scope !== scope || editingRule?.projectId !== projectId) return null
    if (inlineEditId !== 'new') return null
    
    return (
      <div className="rule-item active">
        <IconMessage className="shrink-0" style={{ marginRight: 8, opacity: 0.7 }}/>
        {renderInlineInput()}
      </div>
    )
  }

  return (
    <Flex className="settings-content-wrapper">
      {/* 左侧 - 规则列表 */}
      <Stack className="settings-provider-sidebar" style={{ width: 280 }}>
        <div className="settings-provider-header">
          <h1 className="settings-provider-title">规则设置</h1>
          <p className="settings-provider-desc">管理全局和项目的 Agent 规则，指导 AI 如何编写代码。</p>
        </div>
        
        <Stack className="settings-provider-list-container" style={{ padding: '0 8px' }}>
          {/* 全局规则 */}
          <Stack gap={1} style={{ marginBottom: 16 }}>
            <div 
              className="project-header" 
              style={{ color: 'var(--accent-primary)' }}
            >
              <IconFolder className="shrink-0" style={{ marginRight: 6, fill: 'currentColor' }} />
              <span className="truncate" style={{ flex: 1 }}>全局规则 (Global)</span>
              <div className="project-actions">
                <button className="project-action-btn" onClick={(e) => { e.stopPropagation(); handleNewRule('global') }} title="添加全局规则">
                  <IconMessagePlus />
                </button>
              </div>
            </div>

            {globalRules.map(renderRuleItem)}
            {renderNewRulePlaceholder('global')}
          </Stack>

          {/* 项目规则 */}
          <Stack gap={1}>
            {recentProjects.map(proj => {
              const projRules = workspaceRulesGrouped[proj.id] || []
              const isExpanded = expandedProjects.has(proj.id)
              
              return (
                <Stack key={proj.id} gap={1}>
                  <div 
                    className="project-header"
                    onClick={() => toggleProject(proj.id)}
                  >
                    <IconChevron 
                      className="shrink-0" 
                      style={{ 
                        marginRight: 4, 
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        width: 16, height: 16, opacity: 0.6
                      }} 
                    />
                    <IconFolder className="shrink-0" style={{ marginRight: 6, opacity: 0.8 }} />
                    <span className="truncate" style={{ flex: 1 }}>{proj.name}</span>
                    <div className="project-actions">
                      <button className="project-action-btn" onClick={(e) => { e.stopPropagation(); handleNewRule('workspace', proj.id) }} title="添加项目规则">
                        <IconMessagePlus />
                      </button>
                    </div>
                  </div>
                  
                  {isExpanded && (
                    <Stack gap={1}>
                      {projRules.map(renderRuleItem)}
                      {renderNewRulePlaceholder('workspace', proj.id)}
                      {projRules.length === 0 && activeTabId !== 'new' && (
                        <div style={{ padding: '4px 8px 4px 32px', fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                          暂无规则
                        </div>
                      )}
                    </Stack>
                  )}
                </Stack>
              )
            })}
          </Stack>
        </Stack>
      </Stack>

      {/* 右侧 - 编辑区 */}
      {editingRule ? (
        <Flex direction="col" className="settings-panel-container" style={{ flex: 1, overflow: 'hidden' }}>
          <Flex align="center" justify="between" style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {editingRule.filename ? (
                <>
                  <IconMessage style={{ width: 20, height: 20, color: 'var(--accent-primary)' }} />
                  {editingRule.filename}
                </>
              ) : (
                '未命名规则'
              )}
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

          <div style={{ flex: 1, padding: 24, overflow: 'hidden' }}>
            <MarkdownEditor 
              value={editingRule.content || ''}
              onChange={val => setEditingRule({ ...editingRule, content: val })}
              placeholder={`---\ndescription: 例如规则描述\nglobs: src/**/*.tsx\nalwaysApply: false\n---\n\n# 编写你的规则...`}
            />
          </div>
        </Flex>
      ) : (
        <Flex align="center" justify="center" className="settings-empty-pane">
          请选择左侧的一条规则或新建一条规则
        </Flex>
      )}
    </Flex>
  )
}
