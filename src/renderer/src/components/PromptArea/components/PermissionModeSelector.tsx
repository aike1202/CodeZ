import type { ChangeEvent } from 'react'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import Select from '../../ui/Select'

export default function PermissionModeSelector(): React.ReactElement {
  const workspace = useWorkspaceStore((state) => state.workspace)
  const mode = useWorkspaceStore((state) => state.permissionMode)
  const setMode = useWorkspaceStore((state) => state.setPermissionMode)

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    void setMode(event.target.value as 'auto' | 'full-access')
  }

  return (
    <Select value={mode} onChange={handleChange} disabled={!workspace} title="当前工作区权限模式">
      <option value="auto" title="工作区内读取、编辑、构建与测试直接执行；风险操作询问">自动</option>
      <option value="full-access" title="除极度危险操作外全部自动执行">完全访问</option>
    </Select>
  )
}
