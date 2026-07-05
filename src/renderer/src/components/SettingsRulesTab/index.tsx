import React, { useEffect, useState } from 'react'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import { IconFolder, IconChevron, IconMessagePlus, IconMessage, IconTrash } from '../Icons'
import { useRulesStore } from '../../stores/rulesStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { RuleFile, RuleScope } from '@shared/types/rules'
import MarkdownEditor from '../ui/MarkdownEditor'
import './SettingsRulesTab.css'
import { RuleListItem } from './components/RuleListItem'

export default function SettingsRulesTab(): React.ReactElement {
  const rules = useRulesStore((s) => s.rules)
  const loadRules = useRulesStore((s) => s.loadRules)
  const saveRule = useRulesStore((s) => s.saveRule)
  const deleteRule = useRulesStore((s) => s.deleteRule)
  const renameRule = useRulesStore((s) => s.renameRule)

  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [editingRule, setEditingRule] = useState<Partial<RuleFile> | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineEditValue, setInlineEditValue] = useState('')

  useEffect(() => {
    loadRules()
  }, [])

  const globalRules = rules.filter((r) => r.scope === 'global')
  const workspaceRules = rules.filter((r) => r.scope === 'workspace')
  const recentProjects = useWorkspaceStore((s) => s.recentProjects)

  const workspaceRulesGrouped: Record<string, RuleFile[]> = {}
  workspaceRules.forEach((r) => {
    if (r.projectId) {
      if (!workspaceRulesGrouped[r.projectId]) workspaceRulesGrouped[r.projectId] = []
      workspaceRulesGrouped[r.projectId].push(r)
    }
  })

  useEffect(() => {
    if (recentProjects.length > 0 && expandedProjects.size === 0) {
      setExpandedProjects(new Set(recentProjects.map((p) => p.id)))
    }
  }, [recentProjects])

  const handleSelectRule = (rule: RuleFile) => {
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
      content: '---\ndescription: 例如规则描述\nglobs: src/**/*.tsx\nalwaysApply: false\n---\n\n# ',
      projectId
    })
    setInlineEditId('new')
    setInlineEditValue('')

    if (projectId && !expandedProjects.has(projectId)) {
      setExpandedProjects((prev) => new Set(prev).add(projectId))
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
        setEditingRule((prev) => (prev ? { ...prev, filename: newName } : null))
      } else {
        setActiveTabId(null)
        setEditingRule(null)
      }
      setInlineEditId(null)
      return
    }

    if (newName) {
      const rule = rules.find((r) => r.path === inlineEditId)
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
      if (success && activeTabId === 'new') {
        setActiveTabId(null)
        setEditingRule(null)
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteRule = async (rule: RuleFile) => {
    if (confirm(`确定要删除规则 ${rule.filename} 吗？`)) {
      await deleteRule(rule.path)
      if (activeTabId === rule.path) {
        setActiveTabId(null)
        setEditingRule(null)
      }
    }
  }

  const handleToggleRule = async (rule: RuleFile, enabled: boolean) => {
    let newContent = rule.content
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/
    const match = newContent.match(frontmatterRegex)
    
    if (match) {
      let yamlStr = match[1]
      const enabledMatch = yamlStr.match(/^enabled:.*$/m)
      if (enabledMatch) {
        yamlStr = yamlStr.replace(/^enabled:.*$/m, `enabled: ${enabled}`)
      } else {
        yamlStr = `enabled: ${enabled}\n` + yamlStr
      }
      newContent = newContent.replace(match[0], `---\n${yamlStr}\n---`)
    } else {
      newContent = `---\nenabled: ${enabled}\n---\n\n` + newContent
    }

    const updatedRule = { ...rule, content: newContent, enabled }
    await saveRule(updatedRule)
    if (activeTabId === rule.path && editingRule) {
      setEditingRule({ ...editingRule, content: newContent, enabled })
    }
  }

  const handleDelete = async () => {
    if (!editingRule || !editingRule.path) return
    await handleDeleteRule(editingRule as RuleFile)
  }

  return (
    <Flex className="settings-content-wrapper">
      <Stack className="settings-provider-sidebar" style={{ width: 280 }}>
        <div className="settings-provider-header">
          <h1 className="settings-provider-title">规则设置</h1>
          <p className="settings-provider-desc">管理全局和项目的 Agent 规则，指导 AI 如何编写代码。</p>
        </div>

        <Stack className="settings-provider-list-container" style={{ padding: '0 8px' }}>
          <Stack gap={1} style={{ marginBottom: 16 }}>
            <div className="project-header" style={{ color: 'var(--accent-primary)' }}>
              <IconFolder className="shrink-0" style={{ marginRight: 6, fill: 'currentColor' }} />
              <span className="truncate" style={{ flex: 1 }}>全局规则 (Global)</span>
              <div className="project-actions">
                <button
                  className="project-action-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleNewRule('global')
                  }}
                  title="添加全局规则"
                >
                  <IconMessagePlus />
                </button>
              </div>
            </div>

            {globalRules.map((r) => (
              <RuleListItem
                key={r.path}
                rule={r}
                activeTabId={activeTabId}
                inlineEditId={inlineEditId}
                inlineEditValue={inlineEditValue}
                setInlineEditValue={setInlineEditValue}
                commitRename={commitRename}
                handleSelectRule={handleSelectRule}
                startRename={startRename}
                handleToggleRule={handleToggleRule}
                handleDeleteRule={handleDeleteRule}
              />
            ))}
          </Stack>

          <Stack gap={1}>
            {recentProjects.map((proj) => {
              const projRules = workspaceRulesGrouped[proj.id] || []
              const isExpanded = expandedProjects.has(proj.id)

              return (
                <Stack key={proj.id} gap={1}>
                  <div className="project-header" onClick={() => toggleProject(proj.id)}>
                    <IconChevron
                      className="shrink-0"
                      style={{
                        marginRight: 4,
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        width: 16,
                        height: 16,
                        opacity: 0.6
                      }}
                    />
                    <IconFolder className="shrink-0" style={{ marginRight: 6, opacity: 0.8 }} />
                    <span className="truncate" style={{ flex: 1 }}>{proj.name}</span>
                    <div className="project-actions">
                      <button
                        className="project-action-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleNewRule('workspace', proj.id)
                        }}
                        title="添加项目规则"
                      >
                        <IconMessagePlus />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <Stack gap={1}>
                      {projRules.map((r) => (
                        <RuleListItem
                          key={r.path}
                          rule={r}
                          activeTabId={activeTabId}
                          inlineEditId={inlineEditId}
                          inlineEditValue={inlineEditValue}
                          setInlineEditValue={setInlineEditValue}
                          commitRename={commitRename}
                          handleSelectRule={handleSelectRule}
                          startRename={startRename}
                          handleToggleRule={handleToggleRule}
                          handleDeleteRule={handleDeleteRule}
                        />
                      ))}
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
                <button className="btn btn-danger" onClick={handleDelete} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IconTrash /> 删除
                </button>
              )}
              <button className="btn btn-primary" onClick={handleSave} disabled={!editingRule.filename || isSaving}>
                {isSaving ? '保存中...' : '保存'}
              </button>
            </Flex>
          </Flex>

          <div style={{ flex: 1, overflow: 'hidden' }}>
            <MarkdownEditor
              value={editingRule.content || ''}
              onChange={(val) => setEditingRule({ ...editingRule, content: val })}
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
