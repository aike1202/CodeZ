import React, { ReactNode, useState, useCallback } from 'react';
import './AppLayout.css';

export interface AppLayoutProps {
  /** 左侧边栏组件 */
  sidebar?: ReactNode;
  /** 顶部标题栏/功能栏组件 */
  topbar?: ReactNode;
  
  /** 中间核心工作区（如 ChatArea 等） */
  chatArea?: ReactNode;

  /** 中间核心工作区的内容 (备用/兼容) */
  children?: ReactNode;



  /** 右侧辅助面板组件 (可选) */
  rightPanel?: ReactNode;
  /** 给最外层容器加的额外的类名 */
  className?: string;

  /* ---- 可拖拽宽度控制 (支持受控/非受控) ---- */
  defaultSidebarWidth?: number;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  minSidebarWidth?: number;
  maxSidebarWidth?: number;

  defaultRightPanelWidth?: number;
  rightPanelWidth?: number;
  onRightPanelWidthChange?: (width: number) => void;
  minRightPanelWidth?: number;
  maxRightPanelWidth?: number;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  sidebar,
  topbar,
  chatArea,
  children,
  rightPanel,
  className = '',
  defaultSidebarWidth = 260,
  sidebarWidth: propSidebarWidth,
  onSidebarWidthChange,
  minSidebarWidth = 200,
  maxSidebarWidth = 600,
  defaultRightPanelWidth = 450,
  rightPanelWidth: propRightPanelWidth,
  onRightPanelWidthChange,
  minRightPanelWidth = 300,
  maxRightPanelWidth = 800,
}) => {
  // 注意：Hooks 的声明顺序很重要，必须在它们被使用之前声明
  // --------- 右侧面板宽度状态管理 ---------
  const [internalRightPanelWidth, setInternalRightPanelWidth] = useState(defaultRightPanelWidth);
  const rightPanelWidth = propRightPanelWidth !== undefined ? propRightPanelWidth : internalRightPanelWidth;

  // --------- 左侧边栏宽度状态管理 ---------
  const [internalSidebarWidth, setInternalSidebarWidth] = useState(defaultSidebarWidth);
  const sidebarWidth = propSidebarWidth !== undefined ? propSidebarWidth : internalSidebarWidth;

  const handleSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    
    // 捕获当前的 rightPanelWidth 用于拖拽计算，避免闭包陷阱
    const currentRightPanelWidth = rightPanelWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // 在最小值、最大值和当前窗口允许剩余空间内取值
      const maxAllowed = window.innerWidth - 300 - (rightPanel ? currentRightPanelWidth : 0);
      const actualMax = Math.min(maxSidebarWidth, maxAllowed);
      
      const newWidth = Math.max(minSidebarWidth, Math.min(startWidth + deltaX, actualMax));
      
      if (onSidebarWidthChange) onSidebarWidthChange(newWidth);
      setInternalSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
  }, [sidebarWidth, maxSidebarWidth, minSidebarWidth, onSidebarWidthChange, rightPanel, rightPanelWidth]);


  const handleRightPanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPanelWidth;
    
    // 捕获当前的 sidebarWidth 用于拖拽计算
    const currentSidebarWidth = sidebarWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      // 往左移动鼠标 (deltaX会是负数)，面板变宽
      const deltaX = startX - moveEvent.clientX; 
      
      const maxAllowed = window.innerWidth - currentSidebarWidth - 300;
      const actualMax = Math.min(maxRightPanelWidth, maxAllowed);

      const newWidth = Math.max(minRightPanelWidth, Math.min(startWidth + deltaX, actualMax));
      
      if (onRightPanelWidthChange) onRightPanelWidthChange(newWidth);
      setInternalRightPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
  }, [rightPanelWidth, maxRightPanelWidth, minRightPanelWidth, onRightPanelWidthChange, sidebarWidth]);

  return (
    <div className={`app-layout-root ${className}`}>
      
      {/* ===== 左侧边栏 ===== */}
      {sidebar && (
        <div 
          className="app-layout-sidebar" 
          style={{ width: sidebarWidth }}
        >
          {sidebar}
          {/* 左侧边栏右边界的拖拽条 */}
          <div 
            className="app-layout-resize-handle layout-resize-handle-left"
            onMouseDown={handleSidebarResize}
          />
        </div>
      )}

      {/* ===== 右侧主容器 ===== */}
      <div className="app-layout-main">
        {/* Header */}
        {topbar && (
          <div className="app-layout-header">
            {topbar}
          </div>
        )}

        {/* Content Wrapper */}
        <div className="app-layout-content-wrapper">
          {/* 中间主要工作区 */}
          <div className="app-layout-workspace">
            {chatArea}
            {children}
          </div>

          {/* ===== 右侧面板 ===== */}
          {rightPanel && (
            <div 
              className="app-layout-right-panel"
              style={{ width: rightPanelWidth }}
            >
              {/* 右侧面板左边界的拖拽条 (注意这里的 DOM 结构) */}
              <div 
                className="app-layout-resize-handle layout-resize-handle-right"
                onMouseDown={handleRightPanelResize}
              />
              <div className="app-layout-right-panel-content">
                {rightPanel}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AppLayout;