import React, { useState } from 'react'
import { Zap } from 'lucide-react'
import { useSendMessage } from './hooks/useSendMessage'
import './ParallelExecButton.css'

interface ParallelExecButtonProps {
  planSlug: string
  planTitle: string
  /** 关闭外层弹层的回调（点按钮后收起 popover） */
  onTriggered?: () => void
}

/**
 * Plan 卡片上的「并行执行」触发入口 + 隔离档确认框。
 *
 * 遵循 chat 驱动架构：确认后向主 Agent 发送一条指令，让其先委派 ExecutionPlanner
 * 分析分波，再按用户选择的隔离档调用 ExecutePlanParallel。
 * 单向数据流：本组件只发事件（指令消息），执行进度由 parallelExecStore 渲染。
 */
export const ParallelExecButton: React.FC<ParallelExecButtonProps> = ({
  planSlug,
  planTitle,
  onTriggered,
}) => {
  const [showDialog, setShowDialog] = useState(false)
  const [isolation, setIsolation] = useState<'shared' | 'worktree'>('worktree')
  const { handleSendMessage } = useSendMessage()

  const handleConfirm = () => {
    const instruction = [
      `请并行执行计划「${planTitle}」(slug: ${planSlug})。`,
      '步骤：',
      `1. 委派 ExecutionPlanner 子智能体分析该计划的步骤依赖，产出分波方案（waves）、隔离建议和分组理由。`,
      `2. 使用我选择的隔离档：${isolation === 'worktree' ? 'worktree（物理隔离）' : 'shared（共享目录）'}。`,
      `3. 调用 ExecutePlanParallel 工具执行，传入 planSlug="${planSlug}"、ExecutionPlanner 产出的 grouping、以及 isolation="${isolation}"。`,
      `4. 若返回 halted，向我报告失败的步骤，等我确认后再决定修复重跑。`,
    ].join('\n')

    setShowDialog(false)
    onTriggered?.()
    handleSendMessage(instruction, '', true)
  }

  return (
    <>
      <button
        type="button"
        className="pxb-trigger"
        onClick={(e) => {
          e.stopPropagation()
          setShowDialog(true)
        }}
      >
        <Zap size={13} />
        并行执行
      </button>

      {showDialog && (
        <div className="pxb-overlay" onClick={() => setShowDialog(false)}>
          <div className="pxb-dialog" onClick={(e) => e.stopPropagation()}>
            <h4 className="pxb-title">
              <Zap size={15} /> 并行执行：{planTitle}
            </h4>

            <p className="pxb-hint">
              将先由只读的 ExecutionPlanner 分析步骤依赖并分波，随后组内并行、组间串行执行。
            </p>

            <div className="pxb-field">
              <span className="pxb-field-label">隔离方式：</span>
              <label className="pxb-radio">
                <input
                  type="radio"
                  name="pxb-isolation"
                  checked={isolation === 'worktree'}
                  onChange={() => setIsolation('worktree')}
                />
                worktree（物理隔离，推荐）
              </label>
              <label className="pxb-radio">
                <input
                  type="radio"
                  name="pxb-isolation"
                  checked={isolation === 'shared'}
                  onChange={() => setIsolation('shared')}
                />
                共享目录（更快，需步骤文件完全独立）
              </label>
            </div>

            <div className="pxb-warn">
              ⚠ 本次授权 Worker 在计划声明的文件范围内自主读写，不再逐步弹窗；删除/网络等危险操作仍会拦截。
            </div>

            <div className="pxb-actions">
              <button type="button" className="pxb-btn pxb-btn--cancel" onClick={() => setShowDialog(false)}>
                取消
              </button>
              <button type="button" className="pxb-btn pxb-btn--go" onClick={handleConfirm}>
                开始并行执行
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default ParallelExecButton
