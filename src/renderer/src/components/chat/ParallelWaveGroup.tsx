import React, { useState } from 'react'
import { Loader2, CheckCircle2, CircleDashed, XCircle, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { useParallelExecStore } from '../../stores/parallelExecStore'
import type { ParallelWaveState } from '../../stores/parallelExecStore'
import './ParallelWaveGroup.css'

/**
 * 并行执行波次分组容器。
 *
 * 无状态渲染：所有数据来自 parallelExecStore（主进程唯一数据源）。
 * 展示波次结构 + 每步状态；Worker 的工具日志详情仍由现有 SubAgentCard 承载。
 */
export const ParallelWaveGroup: React.FC = () => {
  const { active, planSlug, isolation, rationale, waves, overallStatus } = useParallelExecStore()

  if (!active || waves.length === 0) return null

  return (
    <div className="pwg-root">
      <div className="pwg-header">
        <Zap size={15} className="pwg-header-icon" />
        <span className="pwg-header-title">并行执行{planSlug ? `：${planSlug}` : ''}</span>
        <span className={`pwg-badge pwg-badge--${overallStatus ?? 'running'}`}>
          {overallStatus === 'completed'
            ? '全部完成'
            : overallStatus === 'halted'
              ? '已停止'
              : '执行中'}
        </span>
      </div>

      {rationale && <div className="pwg-rationale">分组理由：{rationale}</div>}
      {isolation && (
        <div className="pwg-isolation">
          隔离：<code>{isolation === 'worktree' ? 'worktree（物理隔离）' : 'shared（共享目录）'}</code>
        </div>
      )}

      <div className="pwg-waves">
        {waves.map((wave) => (
          <WaveRow key={wave.index} wave={wave} halted={overallStatus === 'halted'} />
        ))}
      </div>
    </div>
  )
}

interface WaveRowProps {
  wave: ParallelWaveState
  halted: boolean
}

function WaveRow({ wave, halted }: WaveRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(wave.status === 'in_progress')

  const doneCount = wave.stepResults.filter((r) => r.status === 'completed').length
  const failCount = wave.stepResults.filter((r) => r.status === 'failed').length
  const total = wave.stepIds.length

  const badgeText =
    wave.status === 'completed'
      ? '完成'
      : wave.status === 'failed'
        ? '失败（停止）'
        : wave.status === 'in_progress'
          ? `执行中 ${doneCount}/${total}`
          : halted
            ? '已取消'
            : '等待中'

  const resultFor = (stepId: string) => wave.stepResults.find((r) => r.stepId === stepId)

  return (
    <div className={`pwg-wave pwg-wave--${wave.status}`}>
      <button type="button" className="pwg-wave-header" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="pwg-wave-title">Wave {wave.index}</span>
        <span className={`pwg-wave-badge pwg-wave-badge--${wave.status}`}>{badgeText}</span>
        {failCount > 0 && <span className="pwg-wave-fail">· {failCount} 失败</span>}
      </button>

      {expanded && (
        <ul className="pwg-step-list">
          {wave.stepIds.map((stepId) => {
            const r = resultFor(stepId)
            const status = r?.status ?? (wave.status === 'in_progress' ? 'running' : 'pending')
            return (
              <li key={stepId} className={`pwg-step pwg-step--${status}`}>
                <StepIcon status={status} waveStatus={wave.status} />
                <span className="pwg-step-id">{stepId}</span>
                {r?.summary && <span className="pwg-step-summary" title={r.summary}>{r.summary}</span>}
                {r?.filesModified?.length ? (
                  <span className="pwg-step-files">✓ {r.filesModified.length} 文件</span>
                ) : null}
                {r?.error && <span className="pwg-step-error" title={r.error}>{r.error}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function StepIcon({
  status,
  waveStatus,
}: {
  status: string
  waveStatus: string
}): React.ReactElement {
  if (status === 'completed') return <CheckCircle2 size={13} className="pwg-icon--ok" />
  if (status === 'failed') return <XCircle size={13} className="pwg-icon--err" />
  if (status === 'running' || waveStatus === 'in_progress')
    return <Loader2 size={13} className="pwg-icon--run spin" />
  return <CircleDashed size={13} className="pwg-icon--pending" />
}

export default ParallelWaveGroup
