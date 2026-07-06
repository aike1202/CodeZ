import React, { ReactNode } from 'react';
import Stack from '../ui/Stack';
import { PlanApprovalCard } from './PlanApprovalCard';
import { PlanCapsule } from '../PlanCapsule';
import { TaskCapsule } from './TaskCapsule';
import { ParallelWaveGroup } from './ParallelWaveGroup';
import { useParallelExecSubscription } from './hooks/useParallelExecSubscription';
import { useTaskSubscription } from './hooks/useTaskSubscription';
import { useChatStore } from '../../stores/chatStore';

export interface ChatAreaLayoutProps {
  messageArea: ReactNode;
  auditArea?: ReactNode;
  promptArea: ReactNode;
  terminalPanel?: ReactNode;
  scrollToBottomButton?: ReactNode;
  panelOpen?: boolean;
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

export const ChatAreaLayout: React.FC<ChatAreaLayoutProps> = ({
  messageArea,
  auditArea,
  promptArea,
  terminalPanel,
  scrollToBottomButton,
  panelOpen,
  containerRef,
  onScroll
}) => {
  useParallelExecSubscription();
  useTaskSubscription();
  return (
    <>
      <Stack
        className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}
        ref={containerRef}
        onScroll={onScroll}
      >
        <PlanCapsule />
        <TaskCapsule />
        <PlanApprovalCard />
        <ParallelWaveGroup />
        {messageArea}
      </Stack>
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
