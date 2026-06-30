import React, { ReactNode } from 'react';
import Stack from '../ui/Stack';

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
        {messageArea}
      </Stack>
      {auditArea}
      {promptArea}
      {terminalPanel}
    </>
  );
};
