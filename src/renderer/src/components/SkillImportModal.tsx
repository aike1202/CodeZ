import React, { useEffect, useState } from 'react'
import type { ExternalSkillGroup, ExternalSkillItem } from '@shared/types/skill'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import Card from './ui/Card'
import Button from './ui/Button'
import { IconClose, IconDownload, IconRefreshCw, IconPackage, IconCheck } from './Icons'
import './SkillImportModal.css'
import { desktopApi } from '../shared/desktop'

interface Props {
  onClose: () => void
  /** 单个技能导入成功后回调，供外层刷新已导入列表 */
  onImported: () => void
}

export default function SkillImportModal({ onClose, onImported }: Props): React.ReactElement {
  const [groups, setGroups] = useState<ExternalSkillGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [importingKey, setImportingKey] = useState<string | null>(null)

  const loadList = async () => {
    setLoading(true)
    try {
      const data = await desktopApi.skill.listExternal()
      setGroups(data)
    } catch (e) {
      console.error('Failed to list external skills', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadList()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleImport = async (skill: ExternalSkillItem) => {
    const key = `${skill.sourceName}/${skill.dirName}`
    setImportingKey(key)
    try {
      const ok = await desktopApi.skill.importSingle(skill.sourceName, skill.dirName)
      if (ok) {
        setGroups((prev) =>
          prev.map((g) =>
            g.sourceName === skill.sourceName
              ? {
                  ...g,
                  skills: g.skills.map((s) =>
                    s.dirName === skill.dirName ? { ...s, imported: true, hasUpdate: false } : s
                  )
                }
              : g
          )
        )
        onImported()
      }
    } catch (e) {
      console.error('Failed to import skill', e)
    } finally {
      setImportingKey(null)
    }
  }

  const totalCount = groups.reduce((sum, g) => sum + g.skills.length, 0)

  return (
    <Flex className="sim-overlay" onClick={onClose}>
      <Card
        variant="default"
        className="sim-card"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <Stack className="sim-inner">
          {/* Header */}
          <Flex align="center" justify="between" className="sim-header">
            <Flex align="center" gap={2.5} className="min-w-0">
              <span className="sim-header-icon">
                <IconDownload className="w-5 h-5" />
              </span>
              <Stack className="min-w-0">
                <span className="sim-header-title">导入外部技能</span>
                <span className="sim-header-sub">从 Codex 与 Claude 中按需选择导入</span>
              </Stack>
            </Flex>
            <Flex align="center" gap={1}>
              <Button variant="ghost" size="none" onClick={loadList} title="刷新">
                <IconRefreshCw className={`w-[18px] h-[18px] ${loading ? 'animate-spin' : ''}`} />
              </Button>
              <Button variant="ghost" size="none" onClick={onClose} className="sim-close-btn">
                <IconClose />
              </Button>
            </Flex>
          </Flex>

          {/* Body */}
          <Stack className="sim-body">
            {loading ? (
              <div className="sim-empty">
                <IconRefreshCw className="w-6 h-6 animate-spin" />
                正在读取外部技能...
              </div>
            ) : totalCount === 0 ? (
              <div className="sim-empty">
                <IconPackage className="w-8 h-8" />
                未检测到 Codex 或 Claude 的技能目录
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.sourceName} className="sim-group">
                  <div className="sim-group-title">
                    {group.sourceName}
                    <span className="sim-group-count">{group.skills.length}</span>
                  </div>
                  {group.skills.length === 0 ? (
                    <div className="sim-group-empty">该来源下暂无可导入的技能</div>
                  ) : (
                    <div className="sim-group-list">
                      {group.skills.map((skill) => {
                        const key = `${skill.sourceName}/${skill.dirName}`
                        const isImporting = importingKey === key
                        return (
                          <div key={key} className="sim-item">
                            <div className="sim-item-icon">
                              <IconPackage className="w-[18px] h-[18px]" />
                            </div>
                            <div className="sim-item-content">
                              <div className="sim-item-name">{skill.name}</div>
                              <p className="sim-item-desc">{skill.description || '无描述信息'}</p>
                            </div>
                            <div className="sim-item-action">
                              {skill.imported && !skill.hasUpdate ? (
                                <span className="sim-item-imported">
                                  <IconCheck className="w-3.5 h-3.5" />
                                  已导入
                                </span>
                              ) : (
                                <Button
                                  variant={skill.hasUpdate ? 'primary' : 'secondary'}
                                  size="small"
                                  loading={isImporting}
                                  disabled={!!importingKey && !isImporting}
                                  onClick={() => handleImport(skill)}
                                >
                                  {skill.hasUpdate ? '更新' : '导入'}
                                </Button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
          </Stack>
        </Stack>
      </Card>
    </Flex>
  )
}
