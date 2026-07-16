use std::{collections::VecDeque, num::NonZeroUsize, sync::Arc};

use tokio::sync::Mutex;

use super::{SubAgentError, SubAgentMessage};

pub(super) const DEFAULT_MAILBOX_CAPACITY: usize = 500;

pub(super) fn default_mailbox_capacity() -> NonZeroUsize {
    match NonZeroUsize::new(DEFAULT_MAILBOX_CAPACITY) {
        Some(capacity) => capacity,
        None => NonZeroUsize::MIN,
    }
}

/// A bounded FIFO mailbox owned by one registered sub-agent.
#[derive(Clone)]
pub(super) struct SubAgentMailbox {
    capacity: NonZeroUsize,
    queue: Arc<Mutex<VecDeque<SubAgentMessage>>>,
}

impl SubAgentMailbox {
    pub(super) fn new(capacity: NonZeroUsize) -> Self {
        Self {
            capacity,
            queue: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub(super) async fn enqueue(&self, message: SubAgentMessage) -> Result<(), SubAgentError> {
        let recipient = message.recipient.clone();
        let mut queue = self.queue.lock().await;
        if queue.len() >= self.capacity.get() {
            return Err(SubAgentError::MailboxFull {
                recipient,
                capacity: self.capacity.get(),
            });
        }

        queue.push_back(message);
        Ok(())
    }

    pub(super) async fn receive(&self) -> Option<SubAgentMessage> {
        self.queue.lock().await.pop_front()
    }

    pub(super) async fn clear(&self) -> usize {
        let mut queue = self.queue.lock().await;
        let cleared = queue.len();
        queue.clear();
        cleared
    }

    pub(super) async fn len(&self) -> usize {
        self.queue.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use chrono::{TimeZone, Utc};

    use super::SubAgentMailbox;
    use crate::agent::sub_agent::{SubAgentError, SubAgentId, SubAgentMessage};

    fn agent_id(value: &str) -> SubAgentId {
        SubAgentId::parse(value).expect("test sub-agent ID must be valid")
    }

    fn message(content: &str) -> SubAgentMessage {
        SubAgentMessage::new(
            agent_id("sender"),
            agent_id("recipient"),
            content,
            Utc.timestamp_opt(1_700_000_000, 0)
                .single()
                .expect("test timestamp must be valid"),
        )
        .expect("test message must be valid")
    }

    #[tokio::test]
    async fn receive_should_preserve_fifo_order() {
        let mailbox = SubAgentMailbox::new(NonZeroUsize::new(2).expect("two is non-zero"));
        mailbox
            .enqueue(message("first"))
            .await
            .expect("first message should fit");
        mailbox
            .enqueue(message("second"))
            .await
            .expect("second message should fit");

        let received = mailbox.receive().await.expect("message should be queued");

        assert_eq!(received.content, "first");
    }

    #[tokio::test]
    async fn enqueue_should_reject_messages_after_capacity_is_reached() {
        let mailbox = SubAgentMailbox::new(NonZeroUsize::new(1).expect("one is non-zero"));
        mailbox
            .enqueue(message("first"))
            .await
            .expect("first message should fit");

        let error = mailbox
            .enqueue(message("second"))
            .await
            .expect_err("second message must not displace the first");

        assert_eq!(
            error,
            SubAgentError::MailboxFull {
                recipient: agent_id("recipient"),
                capacity: 1,
            }
        );
    }
}
