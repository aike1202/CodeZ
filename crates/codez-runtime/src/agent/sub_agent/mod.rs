//! Typed, process-local coordination primitives for delegated agents.
//!
//! This module owns registration, lifecycle validation, and bounded message
//! delivery. It deliberately does not execute models or tools: a future
//! executor must drive [`SubAgentManager::transition`] around actual work.

mod mailbox;
mod manager;
mod resolver;
mod types;

pub use manager::SubAgentManager;
pub use resolver::{SubAgentModelId, SubAgentModelProfile, SubAgentModelResolver};
pub use types::{
    SubAgentError, SubAgentId, SubAgentMessage, SubAgentRegistration, SubAgentRole,
    SubAgentSnapshot, SubAgentStatus,
};
