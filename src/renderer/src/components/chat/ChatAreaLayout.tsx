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
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
  onTouchStart?: (e: React.TouchEvent<HTMLDivElement>) => void;
}

export const ChatAreaLayout: React.FC<ChatAreaLayoutProps> = ({
  messageArea,
  auditArea,
  promptArea,
  terminalPanel,
  panelOpen,
  containerRef,
  onScroll,
  onWheel,
  onTouchStart
}) => {
  return (
    <>
      <Stack
        className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}
        ref={containerRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
      >
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
