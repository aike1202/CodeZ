import React, { ReactNode } from 'react';
import Stack from '../ui/Stack';
import { TodoCapsule } from './TodoCapsule';
import { useParallelExecSubscription } from './hooks/useParallelExecSubscription';
import { useDesktopLifecycleSubscription } from './hooks/useDesktopLifecycleSubscription';
import { useChatStore } from '../../stores/chatStore';

export interface ChatAreaLayoutProps {
  messageArea: ReactNode;
  auditArea?: ReactNode;
  promptArea: ReactNode;
  terminalPanel?: ReactNode;
  scrollToBottomButton?: ReactNode;
  navigationRail?: ReactNode;
  panelOpen?: boolean;
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
}

export const ChatAreaLayout: React.FC<ChatAreaLayoutProps> = ({
  messageArea,
  auditArea,
  promptArea,
  terminalPanel,
  scrollToBottomButton,
  navigationRail,
  panelOpen,
  containerRef,
  onScroll,
  onWheel
}) => {
  useParallelExecSubscription();
  useDesktopLifecycleSubscription();
  return (
    <>
      <div className="app-chat-scroll-shell">
        <Stack
          className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}
          ref={containerRef}
          onScroll={onScroll}
          onWheel={onWheel}
        >
          <TodoCapsule />
          {messageArea}
        </Stack>
        {navigationRail}
      </div>
      {auditArea}
      {scrollToBottomButton && (
        <div className="relative flex justify-center w-full">
          {scrollToBottomButton}
        </div>
      )}
      {promptArea}
      {terminalPanel}
    </>
  );
};
