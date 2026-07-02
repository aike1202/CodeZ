import React from 'react'

export default function PermissionApprovalWidgetMockup() {
  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h3>草图 A：组合菜单型（保持小巧，单据展开）</h3>
      <div style={{
        border: '1px solid #ccc',
        borderRadius: '8px',
        padding: '12px',
        maxWidth: '400px',
        marginBottom: '20px',
        background: '#f9f9f9'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
          <span style={{ fontWeight: 'bold' }}>⚠️ 需要您的授权 (1)</span>
          <div>
            <button style={{ marginRight: '8px' }}>拒绝全部</button>
            <button>允许全部执行 ▾</button>
          </div>
        </div>
        <div style={{ border: '1px solid #ddd', padding: '8px', borderRadius: '4px', background: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             <div>
               <span style={{ background: '#ffe4e6', color: '#be123c', padding: '2px 6px', borderRadius: '12px', fontSize: '12px' }}>高风险</span>
               <span style={{ marginLeft: '8px', color: '#0284c7', fontSize: '13px' }}>Bash</span>
               <span style={{ marginLeft: '8px', fontSize: '13px' }}>npm install axios</span>
             </div>
             <div>
               <button style={{ marginRight: '4px', background: '#f3f4f6', border: 'none', padding: '4px 8px', borderRadius: '4px' }}>拒绝</button>
               <button style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '4px 8px', borderRadius: '4px' }}>允许</button>
             </div>
          </div>
          {/* 折叠区域 */}
          <div style={{ marginTop: '8px', fontSize: '12px', borderTop: '1px dashed #eee', paddingTop: '8px' }}>
            <div style={{ marginBottom: '4px' }}>审批范围:</div>
            <label><input type="radio" checked /> 仅限本次</label>
            <label style={{ marginLeft: '8px' }}><input type="radio" /> 本会话</label>
            <label style={{ marginLeft: '8px' }}><input type="radio" /> 始终</label>
            <div style={{ marginTop: '4px' }}>规则:</div>
            <label><input type="radio" checked /> 匹配: npm install axios</label><br/>
            <label><input type="radio" /> 匹配: npm install *</label>
          </div>
        </div>
      </div>

      <h3>草图 B：直观列表型（取消全部同意按钮，精细并列控制）</h3>
      <div style={{
        border: '1px solid #ccc',
        borderRadius: '8px',
        padding: '12px',
        maxWidth: '500px',
        background: '#f9f9f9'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
          <span style={{ fontWeight: 'bold' }}>⚠️ 拦截了风险命令 (1项)</span>
           {/* 没有允许全部，只有拒绝全部 */}
          <button style={{ color: '#ef4444', border: 'none', background: 'transparent' }}>全部拒绝</button>
        </div>
        <div style={{ border: '1px solid #ddd', padding: '12px', borderRadius: '4px', background: 'white' }}>
          <div style={{ fontSize: '13px', marginBottom: '8px', color: '#4b5563' }}>
            尝试执行 Bash: <code style={{ background: '#f1f5f9', padding: '2px 4px', borderRadius: '4px' }}>npm install axios</code>
          </div>
          
          <div style={{ display: 'flex', gap: '8px', flexDirection: 'column', fontSize: '13px' }}>
             <button style={{ textAlign: 'left', padding: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                ✓ 仅本次允许
             </button>
             <button style={{ textAlign: 'left', padding: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                ⚡ 允许该项目所有的 <code>npm install *</code>
             </button>
             <button style={{ textAlign: 'left', padding: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                🌐 总是允许 <code>npm *</code> 命令
             </button>
          </div>
        </div>
      </div>
    </div>
  )
}
