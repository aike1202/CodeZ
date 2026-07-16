use std::{collections::BTreeMap, num::NonZeroUsize, sync::Arc};

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;

use super::{
    SubAgentError, SubAgentId, SubAgentMessage, SubAgentRegistration, SubAgentSnapshot,
    SubAgentStatus,
    mailbox::{SubAgentMailbox, default_mailbox_capacity},
};

struct SubAgentEntry {
    role: super::SubAgentRole,
    status: SubAgentStatus,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    mailbox: SubAgentMailbox,
}

impl SubAgentEntry {
    fn snapshot(&self, id: &SubAgentId) -> SubAgentSnapshot {
        SubAgentSnapshot {
            id: id.clone(),
            role: self.role.clone(),
            status: self.status,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Coordinates the in-memory lifecycle and mailbox of registered sub-agents.
///
/// Registering an agent does not start a model, process, or tool loop. An
/// execution boundary must register the agent, transition it as execution
/// progresses, and use the message methods for controlled delivery.
#[derive(Clone)]
pub struct SubAgentManager {
    mailbox_capacity: NonZeroUsize,
    sub_agents: Arc<RwLock<BTreeMap<SubAgentId, SubAgentEntry>>>,
}

impl Default for SubAgentManager {
    fn default() -> Self {
        Self::with_mailbox_capacity(default_mailbox_capacity())
    }
}

impl SubAgentManager {
    /// Creates a manager with the default bounded mailbox capacity.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a manager whose mailbox capacity applies independently to each agent.
    #[must_use]
    pub fn with_mailbox_capacity(mailbox_capacity: NonZeroUsize) -> Self {
        Self {
            mailbox_capacity,
            sub_agents: Arc::new(RwLock::new(BTreeMap::new())),
        }
    }

    /// Registers a new idle sub-agent.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::AlreadyRegistered`] when the ID is already in
    /// use by this manager.
    pub async fn register(
        &self,
        registration: SubAgentRegistration,
    ) -> Result<SubAgentSnapshot, SubAgentError> {
        self.register_at(registration, Utc::now()).await
    }

    /// Registers an agent at a caller-supplied timestamp for deterministic recovery and tests.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::AlreadyRegistered`] when the ID is already in
    /// use by this manager.
    pub async fn register_at(
        &self,
        registration: SubAgentRegistration,
        registered_at: DateTime<Utc>,
    ) -> Result<SubAgentSnapshot, SubAgentError> {
        let mut sub_agents = self.sub_agents.write().await;
        if sub_agents.contains_key(&registration.id) {
            return Err(SubAgentError::AlreadyRegistered {
                id: registration.id,
            });
        }

        let id = registration.id;
        let entry = SubAgentEntry {
            role: registration.role,
            status: SubAgentStatus::Idle,
            created_at: registered_at,
            updated_at: registered_at,
            mailbox: SubAgentMailbox::new(self.mailbox_capacity),
        };
        let snapshot = entry.snapshot(&id);
        sub_agents.insert(id, entry);
        Ok(snapshot)
    }

    /// Returns a stable snapshot for one registered sub-agent.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] when the ID is not registered.
    pub async fn snapshot(&self, id: &SubAgentId) -> Result<SubAgentSnapshot, SubAgentError> {
        let sub_agents = self.sub_agents.read().await;
        let entry = sub_agents
            .get(id)
            .ok_or_else(|| SubAgentError::NotFound { id: id.clone() })?;
        Ok(entry.snapshot(id))
    }

    /// Lists all registered agents in lexicographic ID order.
    #[must_use]
    pub async fn list(&self) -> Vec<SubAgentSnapshot> {
        let sub_agents = self.sub_agents.read().await;
        sub_agents
            .iter()
            .map(|(id, entry)| entry.snapshot(id))
            .collect()
    }

    /// Removes one run after its terminal snapshot has been durably persisted.
    ///
    /// Active and resumable agents stay registered so callers cannot discard
    /// lifecycle ownership while work is still in flight.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] for an unknown ID and
    /// [`SubAgentError::NotTerminal`] when the run is still active.
    pub async fn remove_terminal(&self, id: &SubAgentId) -> Result<(), SubAgentError> {
        let mut sub_agents = self.sub_agents.write().await;
        let Some(entry) = sub_agents.get(id) else {
            return Err(SubAgentError::NotFound { id: id.clone() });
        };
        if !matches!(
            entry.status,
            SubAgentStatus::Completed | SubAgentStatus::Failed | SubAgentStatus::Interrupted
        ) {
            return Err(SubAgentError::NotTerminal {
                id: id.clone(),
                status: entry.status,
            });
        }
        sub_agents.remove(id);
        Ok(())
    }

    /// Applies a validated lifecycle transition using the current UTC time.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] for unknown IDs or
    /// [`SubAgentError::InvalidStatusTransition`] for an invalid lifecycle
    /// change.
    pub async fn transition(
        &self,
        id: &SubAgentId,
        next_status: SubAgentStatus,
    ) -> Result<SubAgentSnapshot, SubAgentError> {
        self.transition_at(id, next_status, Utc::now()).await
    }

    /// Applies a validated lifecycle transition at a caller-supplied time.
    ///
    /// Repeating the current status is idempotent and preserves its original
    /// timestamp. Distinct transitions may not move the lifecycle clock
    /// backwards.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] for unknown IDs,
    /// [`SubAgentError::InvalidStatusTransition`] for invalid lifecycle
    /// changes, or [`SubAgentError::StaleTransition`] for out-of-order events.
    pub async fn transition_at(
        &self,
        id: &SubAgentId,
        next_status: SubAgentStatus,
        transitioned_at: DateTime<Utc>,
    ) -> Result<SubAgentSnapshot, SubAgentError> {
        let mut sub_agents = self.sub_agents.write().await;
        let entry = sub_agents
            .get_mut(id)
            .ok_or_else(|| SubAgentError::NotFound { id: id.clone() })?;

        if entry.status == next_status {
            return Ok(entry.snapshot(id));
        }
        if !entry.status.can_transition_to(next_status) {
            return Err(SubAgentError::InvalidStatusTransition {
                id: id.clone(),
                from: entry.status,
                to: next_status,
            });
        }
        if transitioned_at < entry.updated_at {
            return Err(SubAgentError::StaleTransition {
                id: id.clone(),
                current: entry.updated_at,
                attempted: transitioned_at,
            });
        }

        entry.status = next_status;
        entry.updated_at = transitioned_at;
        Ok(entry.snapshot(id))
    }

    /// Delivers a message after verifying that both endpoints are registered.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] for either unknown endpoint or
    /// [`SubAgentError::MailboxFull`] without dropping an earlier message.
    pub async fn send_message(&self, message: SubAgentMessage) -> Result<(), SubAgentError> {
        let recipient_mailbox = {
            let sub_agents = self.sub_agents.read().await;
            if !sub_agents.contains_key(&message.sender) {
                return Err(SubAgentError::NotFound {
                    id: message.sender.clone(),
                });
            }

            sub_agents
                .get(&message.recipient)
                .map(|entry| entry.mailbox.clone())
                .ok_or_else(|| SubAgentError::NotFound {
                    id: message.recipient.clone(),
                })?
        };

        recipient_mailbox.enqueue(message).await
    }

    /// Receives the oldest pending message for one registered sub-agent.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] when the ID is not registered.
    pub async fn receive_message(
        &self,
        id: &SubAgentId,
    ) -> Result<Option<SubAgentMessage>, SubAgentError> {
        Ok(self.mailbox(id).await?.receive().await)
    }

    /// Removes all queued messages for one registered sub-agent and returns the count removed.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] when the ID is not registered.
    pub async fn clear_messages(&self, id: &SubAgentId) -> Result<usize, SubAgentError> {
        Ok(self.mailbox(id).await?.clear().await)
    }

    /// Returns the current pending-message count for one registered sub-agent.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::NotFound`] when the ID is not registered.
    pub async fn pending_message_count(&self, id: &SubAgentId) -> Result<usize, SubAgentError> {
        Ok(self.mailbox(id).await?.len().await)
    }

    async fn mailbox(&self, id: &SubAgentId) -> Result<SubAgentMailbox, SubAgentError> {
        let sub_agents = self.sub_agents.read().await;
        sub_agents
            .get(id)
            .map(|entry| entry.mailbox.clone())
            .ok_or_else(|| SubAgentError::NotFound { id: id.clone() })
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use chrono::{DateTime, TimeZone, Utc};

    use super::SubAgentManager;
    use crate::agent::sub_agent::{
        SubAgentError, SubAgentId, SubAgentMessage, SubAgentRegistration, SubAgentRole,
        SubAgentStatus,
    };

    fn timestamp(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(seconds, 0)
            .single()
            .expect("test timestamp must be valid")
    }

    fn agent_id(value: &str) -> SubAgentId {
        SubAgentId::parse(value).expect("test sub-agent ID must be valid")
    }

    fn role(value: &str) -> SubAgentRole {
        SubAgentRole::parse(value).expect("test role must be valid")
    }

    fn registration(id: &str) -> SubAgentRegistration {
        SubAgentRegistration::new(agent_id(id), role("worker"))
    }

    #[tokio::test]
    async fn register_should_return_an_idle_snapshot() {
        let manager = SubAgentManager::new();

        let snapshot = manager
            .register_at(registration("worker-a"), timestamp(10))
            .await
            .expect("registration should succeed");

        assert_eq!(snapshot.status, SubAgentStatus::Idle);
    }

    #[tokio::test]
    async fn register_should_reject_an_existing_id() {
        let manager = SubAgentManager::new();
        manager
            .register_at(registration("worker-a"), timestamp(10))
            .await
            .expect("first registration should succeed");

        let error = manager
            .register_at(registration("worker-a"), timestamp(11))
            .await
            .expect_err("duplicate registration must fail");

        assert_eq!(
            error,
            SubAgentError::AlreadyRegistered {
                id: agent_id("worker-a"),
            }
        );
    }

    #[tokio::test]
    async fn list_should_order_snapshots_by_id() {
        let manager = SubAgentManager::new();
        manager
            .register_at(registration("worker-z"), timestamp(10))
            .await
            .expect("first registration should succeed");
        manager
            .register_at(registration("worker-a"), timestamp(11))
            .await
            .expect("second registration should succeed");

        let ids = manager
            .list()
            .await
            .into_iter()
            .map(|snapshot| snapshot.id.to_string())
            .collect::<Vec<_>>();

        assert_eq!(ids, ["worker-a", "worker-z"]);
    }

    #[tokio::test]
    async fn transition_should_reject_skipping_the_running_state() {
        let manager = SubAgentManager::new();
        let id = agent_id("worker-a");
        manager
            .register_at(
                SubAgentRegistration::new(id.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("registration should succeed");

        let error = manager
            .transition_at(&id, SubAgentStatus::Completed, timestamp(11))
            .await
            .expect_err("idle agent cannot complete without running");

        assert_eq!(
            error,
            SubAgentError::InvalidStatusTransition {
                id,
                from: SubAgentStatus::Idle,
                to: SubAgentStatus::Completed,
            }
        );
    }

    #[tokio::test]
    async fn transition_should_record_a_startup_failure_before_running() {
        let manager = SubAgentManager::new();
        let id = agent_id("worker-a");
        manager
            .register_at(
                SubAgentRegistration::new(id.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("registration should succeed");

        let snapshot = manager
            .transition_at(&id, SubAgentStatus::Failed, timestamp(11))
            .await
            .expect("startup failure should be terminally recorded");

        assert_eq!(snapshot.status, SubAgentStatus::Failed);
    }

    #[tokio::test]
    async fn transition_should_reject_restarting_a_terminal_agent() {
        let manager = SubAgentManager::new();
        let id = agent_id("worker-a");
        manager
            .register_at(
                SubAgentRegistration::new(id.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("registration should succeed");
        manager
            .transition_at(&id, SubAgentStatus::Running, timestamp(11))
            .await
            .expect("running transition should succeed");
        manager
            .transition_at(&id, SubAgentStatus::Completed, timestamp(12))
            .await
            .expect("completion transition should succeed");

        let error = manager
            .transition_at(&id, SubAgentStatus::Running, timestamp(13))
            .await
            .expect_err("terminal agent must not restart in place");

        assert_eq!(
            error,
            SubAgentError::InvalidStatusTransition {
                id,
                from: SubAgentStatus::Completed,
                to: SubAgentStatus::Running,
            }
        );
    }

    #[tokio::test]
    async fn remove_terminal_should_release_only_a_completed_registration() {
        let manager = SubAgentManager::new();
        let id = agent_id("completed");
        manager
            .register(SubAgentRegistration::new(id.clone(), role("worker")))
            .await
            .expect("test registration must succeed");
        manager
            .transition(&id, SubAgentStatus::Running)
            .await
            .expect("test run must start");
        manager
            .transition(&id, SubAgentStatus::Completed)
            .await
            .expect("test run must complete");

        manager
            .remove_terminal(&id)
            .await
            .expect("completed run must be removable");

        assert!(matches!(
            manager.snapshot(&id).await,
            Err(SubAgentError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn remove_terminal_should_reject_a_running_registration() {
        let manager = SubAgentManager::new();
        let id = agent_id("running");
        manager
            .register(SubAgentRegistration::new(id.clone(), role("worker")))
            .await
            .expect("test registration must succeed");
        manager
            .transition(&id, SubAgentStatus::Running)
            .await
            .expect("test run must start");

        let error = manager
            .remove_terminal(&id)
            .await
            .expect_err("running work must retain lifecycle ownership");

        assert!(matches!(error, SubAgentError::NotTerminal { .. }));
    }

    #[tokio::test]
    async fn transition_should_reject_an_out_of_order_event() {
        let manager = SubAgentManager::new();
        let id = agent_id("worker-a");
        manager
            .register_at(
                SubAgentRegistration::new(id.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("registration should succeed");

        let error = manager
            .transition_at(&id, SubAgentStatus::Running, timestamp(9))
            .await
            .expect_err("older event must not move lifecycle state");

        assert_eq!(
            error,
            SubAgentError::StaleTransition {
                id,
                current: timestamp(10),
                attempted: timestamp(9),
            }
        );
    }

    #[tokio::test]
    async fn send_message_should_deliver_to_the_registered_recipient() {
        let manager = SubAgentManager::new();
        let sender = agent_id("sender");
        let recipient = agent_id("recipient");
        manager
            .register_at(
                SubAgentRegistration::new(sender.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("sender registration should succeed");
        manager
            .register_at(
                SubAgentRegistration::new(recipient.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("recipient registration should succeed");
        let message =
            SubAgentMessage::new(sender, recipient.clone(), "status update", timestamp(11))
                .expect("message should be valid");

        manager
            .send_message(message)
            .await
            .expect("message delivery should succeed");
        let received = manager
            .receive_message(&recipient)
            .await
            .expect("recipient should exist")
            .expect("message should be pending");

        assert_eq!(received.content, "status update");
    }

    #[tokio::test]
    async fn send_message_should_reject_a_nonexistent_sender() {
        let manager = SubAgentManager::new();
        let recipient = agent_id("recipient");
        manager
            .register_at(
                SubAgentRegistration::new(recipient.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("recipient registration should succeed");
        let message = SubAgentMessage::new(
            agent_id("missing"),
            recipient,
            "status update",
            timestamp(11),
        )
        .expect("message should be valid");

        let error = manager
            .send_message(message)
            .await
            .expect_err("unknown sender must not be accepted");

        assert_eq!(
            error,
            SubAgentError::NotFound {
                id: agent_id("missing"),
            }
        );
    }

    #[tokio::test]
    async fn send_message_should_preserve_queued_messages_when_full() {
        let manager =
            SubAgentManager::with_mailbox_capacity(NonZeroUsize::new(1).expect("one is non-zero"));
        let sender = agent_id("sender");
        let recipient = agent_id("recipient");
        manager
            .register_at(
                SubAgentRegistration::new(sender.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("sender registration should succeed");
        manager
            .register_at(
                SubAgentRegistration::new(recipient.clone(), role("worker")),
                timestamp(10),
            )
            .await
            .expect("recipient registration should succeed");
        manager
            .send_message(
                SubAgentMessage::new(sender.clone(), recipient.clone(), "first", timestamp(11))
                    .expect("first message should be valid"),
            )
            .await
            .expect("first message should fit");

        let error = manager
            .send_message(
                SubAgentMessage::new(sender, recipient.clone(), "second", timestamp(12))
                    .expect("second message should be valid"),
            )
            .await
            .expect_err("second message must be rejected");

        assert_eq!(
            error,
            SubAgentError::MailboxFull {
                recipient,
                capacity: 1,
            }
        );
    }
}
