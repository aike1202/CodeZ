use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

pub(super) const MAX_SUB_AGENT_TEXT_BYTES: usize = 512;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Stable, validated identifier for one sub-agent registration.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubAgentId(String);

impl SubAgentId {
    /// Parses an identifier that is safe to store and display.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::InvalidId`] for empty, oversized, padded, or
    /// control-character-containing values.
    pub fn parse(value: impl Into<String>) -> Result<Self, SubAgentError> {
        let value = value.into();
        if !is_valid_sub_agent_text(&value) {
            return Err(SubAgentError::InvalidId);
        }
        Ok(Self(value))
    }

    /// Returns the validated identifier text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SubAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SubAgentId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SubAgentId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Validated role label used to select policy and a configured model profile.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubAgentRole(String);

impl SubAgentRole {
    /// Parses a role label that is safe to store and display.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::InvalidRole`] for empty, oversized, padded, or
    /// control-character-containing values.
    pub fn parse(value: impl Into<String>) -> Result<Self, SubAgentError> {
        let value = value.into();
        if !is_valid_sub_agent_text(&value) {
            return Err(SubAgentError::InvalidRole);
        }
        Ok(Self(value))
    }

    /// Returns the validated role text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SubAgentRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SubAgentRole {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SubAgentRole {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Input required to register a sub-agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentRegistration {
    /// The unique registry key for this agent.
    pub id: SubAgentId,
    /// The role whose policy and model selection will apply.
    pub role: SubAgentRole,
}

impl SubAgentRegistration {
    /// Creates a registration from already validated identity fields.
    #[must_use]
    pub fn new(id: SubAgentId, role: SubAgentRole) -> Self {
        Self { id, role }
    }
}

/// Lifecycle state of a registered sub-agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubAgentStatus {
    /// Registered but no executor has started work.
    Idle,
    /// The executor is actively performing delegated work.
    Running,
    /// Work stopped and requires an explicit resume.
    Paused,
    /// The delegated work completed successfully.
    Completed,
    /// The delegated work ended with an error.
    Failed,
    /// The delegated work was intentionally interrupted.
    Interrupted,
}

impl SubAgentStatus {
    pub(super) const fn can_transition_to(self, next: Self) -> bool {
        match self {
            Self::Idle => matches!(
                next,
                Self::Idle | Self::Running | Self::Failed | Self::Interrupted
            ),
            Self::Running => matches!(
                next,
                Self::Running | Self::Paused | Self::Completed | Self::Failed | Self::Interrupted
            ),
            Self::Paused => matches!(
                next,
                Self::Paused | Self::Running | Self::Failed | Self::Interrupted
            ),
            Self::Completed => matches!(next, Self::Completed),
            Self::Failed => matches!(next, Self::Failed),
            Self::Interrupted => matches!(next, Self::Interrupted),
        }
    }
}

/// Immutable view of a registered sub-agent at one lifecycle point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentSnapshot {
    /// Registry identity.
    pub id: SubAgentId,
    /// Declared role.
    pub role: SubAgentRole,
    /// Current validated lifecycle state.
    pub status: SubAgentStatus,
    /// Registration timestamp.
    pub created_at: DateTime<Utc>,
    /// Timestamp of the most recent distinct lifecycle transition.
    pub updated_at: DateTime<Utc>,
}

/// A validated message routed through a registered recipient's mailbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentMessage {
    /// Registered sender identity.
    pub sender: SubAgentId,
    /// Registered recipient identity.
    pub recipient: SubAgentId,
    /// Bounded message content.
    pub content: String,
    /// Time at which the sender created the message.
    pub sent_at: DateTime<Utc>,
}

impl SubAgentMessage {
    /// Creates a bounded, non-empty message for registered endpoints.
    ///
    /// Endpoint registration is verified by [`super::SubAgentManager::send_message`].
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::InvalidMessageContent`] when content is blank,
    /// exceeds 64 KiB, or contains a NUL byte.
    pub fn new(
        sender: SubAgentId,
        recipient: SubAgentId,
        content: impl Into<String>,
        sent_at: DateTime<Utc>,
    ) -> Result<Self, SubAgentError> {
        let content = content.into();
        if content.trim().is_empty() || content.len() > MAX_MESSAGE_BYTES || content.contains('\0')
        {
            return Err(SubAgentError::InvalidMessageContent);
        }

        Ok(Self {
            sender,
            recipient,
            content,
            sent_at,
        })
    }
}

/// Errors returned by sub-agent registration, lifecycle, mailbox, and profile operations.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SubAgentError {
    /// A sub-agent ID did not satisfy the identity invariant.
    #[error("sub-agent ID must be non-empty, bounded, trimmed, and free of control characters")]
    InvalidId,
    /// A sub-agent role did not satisfy the identity invariant.
    #[error("sub-agent role must be non-empty, bounded, trimmed, and free of control characters")]
    InvalidRole,
    /// A configured provider model identifier did not satisfy the identity invariant.
    #[error(
        "sub-agent model ID must be non-empty, bounded, trimmed, and free of control characters"
    )]
    InvalidModelId,
    /// A profile had no usable total token budget.
    #[error("sub-agent model token budget must be greater than zero")]
    InvalidModelTokenBudget,
    /// A profile output ceiling was not within its total budget.
    #[error(
        "sub-agent model max tokens must be greater than zero and no larger than its token budget"
    )]
    InvalidModelMaxTokens,
    /// A message did not satisfy bounded-content requirements.
    #[error("sub-agent message content must be non-empty, at most 64 KiB, and free of NUL bytes")]
    InvalidMessageContent,
    /// A registration collided with an existing agent ID.
    #[error("sub-agent `{id}` is already registered")]
    AlreadyRegistered { id: SubAgentId },
    /// A requested agent ID does not exist in this manager.
    #[error("sub-agent `{id}` is not registered")]
    NotFound { id: SubAgentId },
    /// A lifecycle event did not follow the permitted transition graph.
    #[error("sub-agent `{id}` cannot transition from {from:?} to {to:?}")]
    InvalidStatusTransition {
        /// The affected agent.
        id: SubAgentId,
        /// The current lifecycle state.
        from: SubAgentStatus,
        /// The requested lifecycle state.
        to: SubAgentStatus,
    },
    /// A lifecycle event arrived earlier than the last applied transition.
    #[error("sub-agent `{id}` received an out-of-order lifecycle transition")]
    StaleTransition {
        /// The affected agent.
        id: SubAgentId,
        /// Timestamp already applied to the lifecycle.
        current: DateTime<Utc>,
        /// Timestamp attached to the rejected event.
        attempted: DateTime<Utc>,
    },
    /// A caller tried to release a run that may still need lifecycle ownership.
    #[error("sub-agent `{id}` is not terminal ({status:?})")]
    NotTerminal {
        /// The run that must remain registered.
        id: SubAgentId,
        /// Its current active or resumable state.
        status: SubAgentStatus,
    },
    /// A recipient mailbox cannot accept another message without dropping one.
    #[error("sub-agent `{recipient}` mailbox is full at capacity {capacity}")]
    MailboxFull {
        /// The recipient whose queue is full.
        recipient: SubAgentId,
        /// The immutable per-agent queue capacity.
        capacity: usize,
    },
    /// More than one explicitly configured model profile targeted the same role.
    #[error("sub-agent role `{role}` has more than one configured model profile")]
    DuplicateModelProfile {
        /// The role with duplicate configuration.
        role: SubAgentRole,
    },
}

pub(super) fn is_valid_sub_agent_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SUB_AGENT_TEXT_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::{SubAgentError, SubAgentId, SubAgentMessage, SubAgentRole};

    #[test]
    fn sub_agent_id_should_reject_padded_input() {
        let error = SubAgentId::parse(" worker ").expect_err("padded ID must fail");

        assert_eq!(error, SubAgentError::InvalidId);
    }

    #[test]
    fn sub_agent_role_should_reject_control_characters() {
        let error = SubAgentRole::parse("worker\nrole").expect_err("control character must fail");

        assert_eq!(error, SubAgentError::InvalidRole);
    }

    #[test]
    fn sub_agent_message_should_reject_blank_content() {
        let error = SubAgentMessage::new(
            SubAgentId::parse("sender").expect("test ID must be valid"),
            SubAgentId::parse("recipient").expect("test ID must be valid"),
            " \n ",
            Utc.timestamp_opt(1_700_000_000, 0)
                .single()
                .expect("test timestamp must be valid"),
        )
        .expect_err("blank message must fail");

        assert_eq!(error, SubAgentError::InvalidMessageContent);
    }

    #[test]
    fn sub_agent_id_deserialization_should_preserve_validation() {
        let error = serde_json::from_str::<SubAgentId>("\" bad \"")
            .expect_err("invalid deserialized ID must fail");

        assert!(error.to_string().contains("sub-agent ID"));
    }
}
