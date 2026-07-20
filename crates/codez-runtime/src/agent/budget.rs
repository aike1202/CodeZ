use std::{collections::HashMap, sync::Mutex};

use codez_core::agent::{AgentBudget, AgentUsage};
use codez_core::{AgentId, RootRunId};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BudgetError {
    #[error("root budget has not been initialized")]
    RootNotInitialized,
    #[error("agent budget has already been reserved")]
    AlreadyReserved,
    #[error("the root has insufficient remaining budget for this child")]
    InsufficientBudget,
    #[error("agent budget reservation was not found")]
    ReservationNotFound,
    #[error("reported usage exceeds the reserved budget")]
    UsageExceeded,
}

#[derive(Debug, Clone, Copy)]
struct RootBudgetState {
    total: AgentBudget,
    committed: AgentUsage,
    reserved: AgentBudget,
}

#[derive(Debug, Clone)]
struct Reservation {
    root_run_id: RootRunId,
    parent_agent_id: Option<AgentId>,
    budget: AgentBudget,
    usage: AgentUsage,
    child_reserved: AgentBudget,
    child_committed: AgentUsage,
}

#[derive(Default)]
struct BudgetState {
    roots: HashMap<RootRunId, RootBudgetState>,
    reservations: HashMap<AgentId, Reservation>,
}

#[derive(Default)]
pub struct AgentBudgetManager {
    state: Mutex<BudgetState>,
}

impl AgentBudgetManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn initialize_root(&self, root_run_id: RootRunId, budget: AgentBudget) {
        self.lock()
            .roots
            .entry(root_run_id)
            .or_insert(RootBudgetState {
                total: budget,
                committed: AgentUsage::default(),
                reserved: zero_budget(),
            });
    }

    pub fn restore_root(&self, root_run_id: RootRunId, budget: AgentBudget, committed: AgentUsage) {
        self.lock()
            .roots
            .entry(root_run_id)
            .or_insert(RootBudgetState {
                total: budget,
                committed,
                reserved: zero_budget(),
            });
    }

    pub fn reserve(
        &self,
        root_run_id: &RootRunId,
        agent_id: AgentId,
        requested: AgentBudget,
    ) -> Result<AgentBudget, BudgetError> {
        let mut state = self.lock();
        if state.reservations.contains_key(&agent_id) {
            return Err(BudgetError::AlreadyReserved);
        }
        let root = state
            .roots
            .get(root_run_id)
            .copied()
            .ok_or(BudgetError::RootNotInitialized)?;
        let remaining =
            subtract_budget(&root.total.saturating_sub(&root.committed), &root.reserved);
        let reservation = remaining.min(&requested);
        if is_zero_budget(&reservation) {
            return Err(BudgetError::InsufficientBudget);
        }
        let root = state
            .roots
            .get_mut(root_run_id)
            .ok_or(BudgetError::RootNotInitialized)?;
        root.reserved = add_budget(&root.reserved, &reservation);
        state.reservations.insert(
            agent_id,
            Reservation {
                root_run_id: root_run_id.clone(),
                parent_agent_id: None,
                budget: reservation,
                usage: AgentUsage::default(),
                child_reserved: zero_budget(),
                child_committed: AgentUsage::default(),
            },
        );
        Ok(reservation)
    }

    pub fn reserve_child(
        &self,
        parent_agent_id: &AgentId,
        child_agent_id: AgentId,
        requested: AgentBudget,
    ) -> Result<AgentBudget, BudgetError> {
        let mut state = self.lock();
        if state.reservations.contains_key(&child_agent_id) {
            return Err(BudgetError::AlreadyReserved);
        }
        let parent = state
            .reservations
            .get(parent_agent_id)
            .ok_or(BudgetError::ReservationNotFound)?;
        let remaining = reservation_remaining(parent);
        let reservation = remaining.min(&requested);
        if is_zero_budget(&reservation) {
            return Err(BudgetError::InsufficientBudget);
        }
        let root_run_id = parent.root_run_id.clone();
        let parent = state
            .reservations
            .get_mut(parent_agent_id)
            .ok_or(BudgetError::ReservationNotFound)?;
        parent.child_reserved = add_budget(&parent.child_reserved, &reservation);
        state.reservations.insert(
            child_agent_id,
            Reservation {
                root_run_id,
                parent_agent_id: Some(parent_agent_id.clone()),
                budget: reservation,
                usage: AgentUsage::default(),
                child_reserved: zero_budget(),
                child_committed: AgentUsage::default(),
            },
        );
        Ok(reservation)
    }

    pub fn record_usage(
        &self,
        agent_id: &AgentId,
        usage: AgentUsage,
    ) -> Result<AgentBudget, BudgetError> {
        let mut state = self.lock();
        let reservation = state
            .reservations
            .get_mut(agent_id)
            .ok_or(BudgetError::ReservationNotFound)?;
        if !combined_usage_within_budget(
            &usage,
            &reservation.child_committed,
            &reservation.child_reserved,
            &reservation.budget,
        ) {
            return Err(BudgetError::UsageExceeded);
        }
        reservation.usage = usage;
        Ok(reservation_remaining(reservation))
    }

    pub fn release(&self, agent_id: &AgentId) -> Result<AgentUsage, BudgetError> {
        let mut state = self.lock();
        let reservation = state
            .reservations
            .remove(agent_id)
            .ok_or(BudgetError::ReservationNotFound)?;
        if !is_empty_budget(&reservation.child_reserved) {
            state.reservations.insert(agent_id.clone(), reservation);
            return Err(BudgetError::UsageExceeded);
        }
        let total_usage = add_usage(&reservation.usage, &reservation.child_committed);
        if let Some(parent_agent_id) = reservation.parent_agent_id {
            let parent = state
                .reservations
                .get_mut(&parent_agent_id)
                .ok_or(BudgetError::ReservationNotFound)?;
            parent.child_reserved = subtract_budget(&parent.child_reserved, &reservation.budget);
            parent.child_committed = add_usage(&parent.child_committed, &total_usage);
        } else {
            let root = state
                .roots
                .get_mut(&reservation.root_run_id)
                .ok_or(BudgetError::RootNotInitialized)?;
            root.reserved = subtract_budget(&root.reserved, &reservation.budget);
            root.committed = add_usage(&root.committed, &total_usage);
        }
        Ok(total_usage)
    }

    #[must_use]
    pub fn root_remaining(&self, root_run_id: &RootRunId) -> Option<AgentBudget> {
        let state = self.lock();
        state.roots.get(root_run_id).map(|root| {
            subtract_budget(&root.total.saturating_sub(&root.committed), &root.reserved)
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BudgetState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

const fn zero_budget() -> AgentBudget {
    AgentBudget {
        input_tokens: 0,
        output_tokens: 0,
        provider_cost_micros: 0,
        tool_calls: 0,
        model_visible_tool_result_bytes: 0,
        command_wall_time_ms: 0,
        wall_time_ms: 0,
        files_read: 0,
        files_written: 0,
        child_agents: 0,
    }
}

const fn add_budget(left: &AgentBudget, right: &AgentBudget) -> AgentBudget {
    AgentBudget {
        input_tokens: left.input_tokens.saturating_add(right.input_tokens),
        output_tokens: left.output_tokens.saturating_add(right.output_tokens),
        provider_cost_micros: left
            .provider_cost_micros
            .saturating_add(right.provider_cost_micros),
        tool_calls: left.tool_calls.saturating_add(right.tool_calls),
        model_visible_tool_result_bytes: left
            .model_visible_tool_result_bytes
            .saturating_add(right.model_visible_tool_result_bytes),
        command_wall_time_ms: left
            .command_wall_time_ms
            .saturating_add(right.command_wall_time_ms),
        wall_time_ms: left.wall_time_ms.saturating_add(right.wall_time_ms),
        files_read: left.files_read.saturating_add(right.files_read),
        files_written: left.files_written.saturating_add(right.files_written),
        child_agents: left.child_agents.saturating_add(right.child_agents),
    }
}

const fn subtract_budget(left: &AgentBudget, right: &AgentBudget) -> AgentBudget {
    AgentBudget {
        input_tokens: left.input_tokens.saturating_sub(right.input_tokens),
        output_tokens: left.output_tokens.saturating_sub(right.output_tokens),
        provider_cost_micros: left
            .provider_cost_micros
            .saturating_sub(right.provider_cost_micros),
        tool_calls: left.tool_calls.saturating_sub(right.tool_calls),
        model_visible_tool_result_bytes: left
            .model_visible_tool_result_bytes
            .saturating_sub(right.model_visible_tool_result_bytes),
        command_wall_time_ms: left
            .command_wall_time_ms
            .saturating_sub(right.command_wall_time_ms),
        wall_time_ms: left.wall_time_ms.saturating_sub(right.wall_time_ms),
        files_read: left.files_read.saturating_sub(right.files_read),
        files_written: left.files_written.saturating_sub(right.files_written),
        child_agents: left.child_agents.saturating_sub(right.child_agents),
    }
}

const fn add_usage(left: &AgentUsage, right: &AgentUsage) -> AgentUsage {
    AgentUsage {
        input_tokens: left.input_tokens.saturating_add(right.input_tokens),
        output_tokens: left.output_tokens.saturating_add(right.output_tokens),
        provider_cost_micros: left
            .provider_cost_micros
            .saturating_add(right.provider_cost_micros),
        tool_calls: left.tool_calls.saturating_add(right.tool_calls),
        model_visible_tool_result_bytes: left
            .model_visible_tool_result_bytes
            .saturating_add(right.model_visible_tool_result_bytes),
        command_wall_time_ms: left
            .command_wall_time_ms
            .saturating_add(right.command_wall_time_ms),
        wall_time_ms: left.wall_time_ms.saturating_add(right.wall_time_ms),
        files_read: left.files_read.saturating_add(right.files_read),
        files_written: left.files_written.saturating_add(right.files_written),
        child_agents: left.child_agents.saturating_add(right.child_agents),
    }
}

const fn is_zero_budget(budget: &AgentBudget) -> bool {
    budget.input_tokens == 0
        || budget.output_tokens == 0
        || budget.tool_calls == 0
        || budget.wall_time_ms == 0
}

const fn is_empty_budget(budget: &AgentBudget) -> bool {
    budget.input_tokens == 0
        && budget.output_tokens == 0
        && budget.provider_cost_micros == 0
        && budget.tool_calls == 0
        && budget.model_visible_tool_result_bytes == 0
        && budget.command_wall_time_ms == 0
        && budget.wall_time_ms == 0
        && budget.files_read == 0
        && budget.files_written == 0
        && budget.child_agents == 0
}

const fn combined_usage_within_budget(
    direct: &AgentUsage,
    child_committed: &AgentUsage,
    child_reserved: &AgentBudget,
    budget: &AgentBudget,
) -> bool {
    direct
        .input_tokens
        .saturating_add(child_committed.input_tokens)
        .saturating_add(child_reserved.input_tokens)
        <= budget.input_tokens
        && direct
            .output_tokens
            .saturating_add(child_committed.output_tokens)
            .saturating_add(child_reserved.output_tokens)
            <= budget.output_tokens
        && direct
            .provider_cost_micros
            .saturating_add(child_committed.provider_cost_micros)
            .saturating_add(child_reserved.provider_cost_micros)
            <= budget.provider_cost_micros
        && direct
            .tool_calls
            .saturating_add(child_committed.tool_calls)
            .saturating_add(child_reserved.tool_calls)
            <= budget.tool_calls
        && direct
            .model_visible_tool_result_bytes
            .saturating_add(child_committed.model_visible_tool_result_bytes)
            .saturating_add(child_reserved.model_visible_tool_result_bytes)
            <= budget.model_visible_tool_result_bytes
        && direct
            .command_wall_time_ms
            .saturating_add(child_committed.command_wall_time_ms)
            .saturating_add(child_reserved.command_wall_time_ms)
            <= budget.command_wall_time_ms
        && direct
            .wall_time_ms
            .saturating_add(child_committed.wall_time_ms)
            .saturating_add(child_reserved.wall_time_ms)
            <= budget.wall_time_ms
        && direct
            .files_read
            .saturating_add(child_committed.files_read)
            .saturating_add(child_reserved.files_read)
            <= budget.files_read
        && direct
            .files_written
            .saturating_add(child_committed.files_written)
            .saturating_add(child_reserved.files_written)
            <= budget.files_written
        && direct
            .child_agents
            .saturating_add(child_committed.child_agents)
            .saturating_add(child_reserved.child_agents)
            <= budget.child_agents
}

const fn reservation_remaining(reservation: &Reservation) -> AgentBudget {
    subtract_budget(
        &subtract_budget(
            &reservation.budget.saturating_sub(&reservation.usage),
            &usage_as_budget(&reservation.child_committed),
        ),
        &reservation.child_reserved,
    )
}

const fn usage_as_budget(usage: &AgentUsage) -> AgentBudget {
    AgentBudget {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        provider_cost_micros: usage.provider_cost_micros,
        tool_calls: usage.tool_calls,
        model_visible_tool_result_bytes: usage.model_visible_tool_result_bytes,
        command_wall_time_ms: usage.command_wall_time_ms,
        wall_time_ms: usage.wall_time_ms,
        files_read: usage.files_read,
        files_written: usage.files_written,
        child_agents: usage.child_agents,
    }
}

#[cfg(test)]
mod tests {
    use codez_core::agent::{AgentBudget, AgentUsage};
    use codez_core::{AgentId, RootRunId};

    use super::AgentBudgetManager;

    #[test]
    fn reservation_should_return_unused_budget_to_the_root() {
        let manager = AgentBudgetManager::new();
        let root = RootRunId::parse("root-1").expect("fixture root id is valid");
        let agent = AgentId::parse("agent-1").expect("fixture agent id is valid");
        let total = AgentBudget::conservative_child();
        manager.initialize_root(root.clone(), total);
        let reserved = manager
            .reserve(&root, agent.clone(), total)
            .expect("fixture budget must reserve");
        let usage = AgentUsage {
            input_tokens: 100,
            ..AgentUsage::default()
        };
        manager
            .record_usage(&agent, usage)
            .expect("usage is within reservation");
        manager.release(&agent).expect("reservation must release");

        assert_eq!(
            manager
                .root_remaining(&root)
                .expect("root remains initialized")
                .input_tokens,
            reserved.input_tokens - usage.input_tokens
        );
    }
}
