import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { SkillDefinition } from '@shared/types/skill'
import Flex from './ui/Flex'
import Button from './ui/Button'
import Input from './ui/Input'
import { IconAdd, IconDownload, IconRefreshCw, IconPackage, IconSearch, IconTrash, IconFolderOpen } from './Icons'
import SkillImportModal from './SkillImportModal'
import './SettingsSkillsTab.css'

interface Props {
  onCreate?: () => void
}

export default function SettingsSkillsTab({ onCreate }: Props): React.ReactElement {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [externalCheckResult, setExternalCheckResult] = useState<{ hasUpdates: boolean; totalCount: number; sources: { sourceName: string; count: number }[] } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadSkills = async () => {
    setLoading(true)
    try {
      const data = await window.api.skill.getAll(workspace?.rootPath || null)
      setSkills(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }

    try {
      const checkRes = await window.api.skill.checkExternal()
      setExternalCheckResult(checkRes)
    } catch (e) {
      console.error('Failed to check external skills', e)
    }
  }

  useEffect(() => {
    loadSkills()
  }, [workspace])

  const handleToggle = async (id: string, enabled: boolean) => {
    setSkills(skills.map(s => s.id === id ? { ...s, enabled } : s))
    try {
      await window.api.skill.toggle(workspace?.rootPath || null, id, enabled)
    } catch (e) {
      console.error('Failed to toggle skill', e)
      setSkills(skills.map(s => s.id === id ? { ...s, enabled: !enabled } : s))
    }
  }

  const handleDelete = async (skill: SkillDefinition) => {
    const ok = window.confirm(`确定要删除技能「${skill.name}」吗？此操作将从本地技能目录中移除它，不可撤销。`)
    if (!ok) return
    setDeletingId(skill.id)
    try {
      const success = await window.api.skill.remove(workspace?.rootPath || null, skill.id)
      if (success) {
        setSkills((prev) => prev.filter((s) => s.id !== skill.id))
      }
    } catch (e) {
      console.error('Failed to delete skill', e)
    } finally {
      setDeletingId(null)
    }
  }

  const handleOpenFolder = async () => {
    if (!workspace) return
    try {
      await window.api.workspace.openInExplorer(workspace.rootPath + '/.skills')
    } catch (e) {
      console.error(e)
    }
  }

  const filteredSkills = skills.filter(s =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const systemSkills = filteredSkills.filter((s) => s.builtin)
  const userSkills = filteredSkills.filter((s) => !s.builtin)

  const renderSkillItem = (skill: SkillDefinition) => (
    <div key={skill.id} className="skills-list-item">
      <div className="skills-item-icon-wrapper">
        <IconPackage className="w-5 h-5" />
      </div>

      <div className="skills-item-content">
        <div className="skills-item-name">{skill.name}</div>
        <p className="skills-item-desc">{skill.description || '无描述信息'}</p>
      </div>

      <div className="skills-item-actions">
        <span className="skills-item-type">
          {skill.builtin ? '系统' : skill.isGlobal ? '个人' : '项目'}
        </span>
        <label className="skills-switch-label">
          <input
            type="checkbox"
            className="skills-switch-input"
            checked={!!skill.enabled}
            onChange={(e) => handleToggle(skill.id, e.target.checked)}
          />
          <div className="skills-switch-inner"></div>
        </label>
        {!skill.builtin && (
          <button
            className="skills-item-delete"
            title="删除技能"
            disabled={deletingId === skill.id}
            onClick={() => handleDelete(skill)}
          >
            <IconTrash className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="skills-tab-container">
      {/* Header */}
      <Flex justify="between" align="start" className="mb-6">
        <div>
          <h1 className="skills-title">技能</h1>
          <p className="skills-subtitle">
            系统技能随应用内置、不可删除但可启停；用户技能可自由增删。启用后可在聊天里通过 /skill-name 使用。
          </p>
        </div>
        <div className="skills-action-group">
          <Button
            variant="ghost"
            size="none"
            onClick={() => onCreate?.()}
            title="新建技能（AI 帮你写）"
          >
            <IconAdd className="w-[18px] h-[18px]" />
          </Button>

          <Button
            variant="ghost"
            size="none"
            onClick={handleOpenFolder}
            title="打开本地技能目录"
          >
            <IconFolderOpen className="w-[18px] h-[18px]" />
          </Button>

          <Button
            variant="ghost"
            size="none"
            onClick={() => setShowImportModal(true)}
            title="从 Codex / Claude 选择性导入技能"
            className="relative"
          >
            <IconDownload className="w-[18px] h-[18px]" />
            {externalCheckResult?.hasUpdates && (
              <span className="skills-badge-dot"></span>
            )}
          </Button>

          <Button
            variant="ghost"
            size="none"
            onClick={loadSkills}
          >
            <IconRefreshCw className={`w-[18px] h-[18px] ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </Flex>

      {/* Search Bar */}
      <div className="skills-search-wrapper">
        <IconSearch className="skills-search-icon" />
        <Input
          type="text"
          placeholder="搜索技能..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="skills-search-input"
          size="large"
        />
      </div>

      {/* 分区：系统技能（只读，可启停） / 用户技能（可增删） */}
      {loading ? (
        <div className="skills-list-container">
          <div className="skills-list-loading">
            <IconRefreshCw className="w-6 h-6 animate-spin" />
            正在同步数据...
          </div>
        </div>
      ) : (
        <>
          {/* 系统技能 */}
          <div className="skills-list-title">
            系统技能 <span className="skills-list-count">{systemSkills.length}</span>
          </div>
          <div className="skills-list-container">
            {systemSkills.length === 0 ? (
              <div className="skills-list-empty">
                <IconPackage className="w-8 h-8" />
                没有系统技能
              </div>
            ) : (
              <div className="skills-list-items">{systemSkills.map(renderSkillItem)}</div>
            )}
          </div>

          {/* 用户技能 */}
          <div className="skills-list-title" style={{ marginTop: 16 }}>
            用户技能 <span className="skills-list-count">{userSkills.length}</span>
          </div>
          <div className="skills-list-container">
            {userSkills.length === 0 ? (
              <div className="skills-list-empty">
                <IconPackage className="w-8 h-8" />
                没有找到对应的技能
              </div>
            ) : (
              <div className="skills-list-items">{userSkills.map(renderSkillItem)}</div>
            )}
          </div>
        </>
      )}

      {showImportModal && (
        <SkillImportModal
          onClose={() => setShowImportModal(false)}
          onImported={loadSkills}
        />
      )}
    </div>
  )
}
