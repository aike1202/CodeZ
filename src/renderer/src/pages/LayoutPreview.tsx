import React, { useState } from 'react';
import AppLayout from '../components/layout/AppLayout';
import './LayoutPreview.css';

const LayoutPreview: React.FC = () => {
  const [showRightPanel, setShowRightPanel] = useState(true);
  
  // 模拟权限审核面板的展示状态
  const [showPermission, setShowPermission] = useState(true);
  
  const [rightPanelWidth, setRightPanelWidth] = useState(480);
  const [sidebarWidth, setSidebarWidth] = useState(260);

  // 模拟假数据
  const SidebarContent = (
    <div className="preview-placeholder-sidebar" style={{ border: '4px solid #ff6b6b' }}>
      <div className="preview-sidebar-top">
         <div className="preview-sidebar-menu">🔍 搜索</div>
         <div className="preview-sidebar-menu">🧩 插件</div>
         <div className="preview-sidebar-menu">⏱️ 自动化</div>
      </div>
      <div className="preview-sidebar-middle">
        <div style={{ marginBottom: 12, fontWeight: 'bold', color: '#333' }}>项目</div>
        <div className="preview-sidebar-item">📁 CodeZ (当前)</div>
        <div className="preview-sidebar-item">📁 Todo</div>
        <div className="preview-sidebar-item">📁 MyAgent</div>
        <div 
           className="preview-sidebar-item" 
           style={{ marginTop: 24, fontStyle: 'italic', color: '#3b82f6' }}
           onClick={() => setShowPermission(true)}
        >
          [点我重置权限面板]
        </div>
      </div>
    </div>
  );

  const TopBarContent = (
    <div className="preview-placeholder-topbar" style={{ border: '4px solid #339af0' }}>
      <div style={{ display: 'flex', gap: 16 }}>
        <strong>CodeZ</strong> ▼
      </div>
      <div className="preview-topbar-center">
        ⌘K 搜索...
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <button onClick={() => setShowRightPanel(!showRightPanel)}>
          {showRightPanel ? '隐藏右面板' : '显示右面板'}
        </button>
        <span>_ ⬜ ✕</span>
      </div>
    </div>
  );

  const RightPanelContent = (
    <div className="preview-placeholder-rightpanel" style={{ border: '4px solid #fcc419' }}>
      <div className="preview-rightpanel-content">
        右侧面板区域 (橙框)
        <br/><br/>
        (例如：代码预览、文件详情)
      </div>
    </div>
  );

  return (
    <AppLayout
      sidebar={SidebarContent}
      topbar={TopBarContent}
      rightPanel={showRightPanel ? RightPanelContent : undefined}
      rightPanelWidth={rightPanelWidth}
      onRightPanelWidthChange={setRightPanelWidth}
      sidebarWidth={sidebarWidth}
      onSidebarWidthChange={setSidebarWidth}
    >
      {/* 工作区内容（将挂载在绿框里面） */}
      <div className="preview-placeholder-workspace" style={{ border: '4px solid #51cf66' }}>
        
        {/* 聊天列表区 */}
        <div className="preview-chat-list">
          中间工作区 (绿框大区域) - 例如 ChatList
        </div>
        
        {/* 悬浮/插进在输入框上方的权限审批区域 */}
        {showPermission && (
          <div className="preview-permission-panel">
            <div>
              <strong>⚠️ 审批请求：</strong>
              <span>执行命令 `npm install lodash`</span>
            </div>
            <div className="preview-permission-actions">
              <button 
                className="preview-btn-reject" 
                onClick={() => setShowPermission(false)}
              >
                拒绝
              </button>
              <button 
                className="preview-btn-accept"
                onClick={() => setShowPermission(false)}
              >
                接受并执行
              </button>
            </div>
          </div>
        )}
        
        {/* 底部的输入框 */}
        <div className="preview-chat-input" style={{ border: '4px solid #ff6b6b' }}>
          底部输入区 (红框小区域)
        </div>
        
      </div>
    </AppLayout>
  );
};

export default LayoutPreview;