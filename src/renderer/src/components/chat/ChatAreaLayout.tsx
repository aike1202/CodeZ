import React, { ReactNode } from 'react';
import Stack from '../ui/Stack';
import { PlanPanel } from './PlanPanel';
import { useChatStore } from '../../stores/chatStore';

export interface ChatAreaLayoutProps {
  messageArea: ReactNode;
  auditArea?: ReactNode;
  promptArea: ReactNode;
  terminalPanel?: ReactNode;
  panelOpen?: boolean;
  containerRef?: React.RefObject<HTMLDivElement>;
}

export const ChatAreaLayout: React.FC<ChatAreaLayoutProps> = ({
  messageArea,
  auditArea,
  promptArea,
  terminalPanel,
  panelOpen,
  containerRef
}) => {
  const planMode = useChatStore((s) => s.planMode)

  return (
    <>
      <Stack className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`} ref={containerRef}>
        {planMode && <PlanPanel />}
        {messageArea}
      </Stack>
      {auditArea}
      {promptArea}
      {terminalPanel}
    </>
  );
};
