import React, { ReactNode } from 'react';
import Stack from '../ui/Stack';
import { PlanApprovalCard } from './PlanApprovalCard';
import { PlanCapsule } from '../PlanCapsule';
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
  return (
    <>
      <Stack className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`} ref={containerRef}>
        <PlanCapsule />
        <PlanApprovalCard />
        {messageArea}
      </Stack>
      {auditArea}
      {promptArea}
      {terminalPanel}
    </>
  );
};
