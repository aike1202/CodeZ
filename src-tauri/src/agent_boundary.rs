use codez_contracts::agent as wire;
use codez_core::agent as domain;

pub(crate) const fn state_contract(value: domain::AgentState) -> wire::AgentState {
    match value {
        domain::AgentState::Created => wire::AgentState::Created,
        domain::AgentState::Queued => wire::AgentState::Queued,
        domain::AgentState::Starting => wire::AgentState::Starting,
        domain::AgentState::Running => wire::AgentState::Running,
        domain::AgentState::WaitingMessage => wire::AgentState::WaitingMessage,
        domain::AgentState::WaitingChildren => wire::AgentState::WaitingChildren,
        domain::AgentState::AwaitingApproval => wire::AgentState::AwaitingApproval,
        domain::AgentState::NeedsReplan => wire::AgentState::NeedsReplan,
        domain::AgentState::NeedsResolution => wire::AgentState::NeedsResolution,
        domain::AgentState::Completed => wire::AgentState::Completed,
        domain::AgentState::Blocked => wire::AgentState::Blocked,
        domain::AgentState::Failed => wire::AgentState::Failed,
        domain::AgentState::Cancelled => wire::AgentState::Cancelled,
        domain::AgentState::Interrupted => wire::AgentState::Interrupted,
    }
}

pub(crate) const fn profile_contract(value: domain::AgentProfile) -> wire::AgentProfile {
    match value {
        domain::AgentProfile::General => wire::AgentProfile::General,
        domain::AgentProfile::Explore => wire::AgentProfile::Explore,
        domain::AgentProfile::Review => wire::AgentProfile::Review,
        domain::AgentProfile::Integration => wire::AgentProfile::Integration,
    }
}

pub(crate) const fn message_kind_contract(value: domain::MessageKind) -> wire::AgentMessageKind {
    match value {
        domain::MessageKind::Instruction => wire::AgentMessageKind::Instruction,
        domain::MessageKind::Question => wire::AgentMessageKind::Question,
        domain::MessageKind::Answer => wire::AgentMessageKind::Answer,
        domain::MessageKind::Progress => wire::AgentMessageKind::Progress,
        domain::MessageKind::Finding => wire::AgentMessageKind::Finding,
        domain::MessageKind::Result => wire::AgentMessageKind::Result,
        domain::MessageKind::CancelRequest => wire::AgentMessageKind::CancelRequest,
        domain::MessageKind::ContractChange => wire::AgentMessageKind::ContractChange,
        domain::MessageKind::SystemNotice => wire::AgentMessageKind::SystemNotice,
    }
}

pub(crate) fn node_contract(value: &domain::AgentNode) -> wire::AgentNode {
    wire::AgentNode {
        schema_version: value.schema_version,
        id: value.id.to_string(),
        root_run_id: value.root_run_id.to_string(),
        root_session_id: value.root_session_id.as_str().to_string(),
        parent_id: value.parent_id.as_ref().map(ToString::to_string),
        depth: value.depth,
        profile: profile_contract(value.profile),
        task: task_contract(&value.task),
        policy: policy_contract(&value.policy),
        budget: budget_contract(value.budget),
        workspace: workspace_contract(&value.workspace),
        state: state_contract(value.state),
        state_revision: value.state_revision,
        created_by_tool_call_id: value.created_by_tool_call_id.clone(),
        created_at: value.created_at.clone(),
        updated_at: value.updated_at.clone(),
    }
}

pub(crate) fn attempt_contract(value: &domain::AgentAttempt) -> wire::AgentAttempt {
    wire::AgentAttempt {
        id: value.id.to_string(),
        agent_id: value.agent_id.to_string(),
        ordinal: value.ordinal,
        state: state_contract(value.state),
        state_revision: value.state_revision,
        mailbox_cursor: value.mailbox_cursor,
        prompt_schema_version: value.prompt_schema_version,
        prompt_module_hashes: value.prompt_module_hashes.clone(),
        dynamic_snapshot_hash: value.dynamic_snapshot_hash.clone(),
        tool_catalog_fingerprint: value.tool_catalog_fingerprint.clone(),
        provider_id: value.provider_id.clone(),
        model_id: value.model_id.clone(),
        result_contract_version: value.result_contract_version,
        usage: usage_contract(value.usage),
        started_at: value.started_at.clone(),
        finished_at: value.finished_at.clone(),
    }
}

pub(crate) fn message_contract(value: &domain::AgentMessage) -> wire::AgentMessage {
    wire::AgentMessage {
        id: value.id.to_string(),
        root_run_id: value.root_run_id.to_string(),
        from: value.from.to_string(),
        to: value.to.to_string(),
        kind: message_kind_contract(value.kind),
        correlation_id: value.correlation_id.clone(),
        reply_to: value.reply_to.as_ref().map(ToString::to_string),
        idempotency_key: value.idempotency_key.clone(),
        sequence: value.sequence,
        summary: value.summary.clone(),
        artifact_refs: value
            .artifact_refs
            .iter()
            .map(ToString::to_string)
            .collect(),
        created_at: value.created_at.clone(),
    }
}

pub(crate) fn result_contract(value: &domain::AgentResult) -> wire::AgentResult {
    wire::AgentResult {
        status: match value.status {
            domain::AgentResultStatus::Completed => wire::AgentResultStatus::Completed,
            domain::AgentResultStatus::Partial => wire::AgentResultStatus::Partial,
            domain::AgentResultStatus::Blocked => wire::AgentResultStatus::Blocked,
            domain::AgentResultStatus::Failed => wire::AgentResultStatus::Failed,
        },
        summary: value.summary.clone(),
        conclusion: value.conclusion.clone(),
        changes: value
            .changes
            .iter()
            .map(|change| wire::AgentChangedArtifact {
                path: change.path.clone(),
                kind: change.kind.clone(),
                purpose: change.purpose.clone(),
            })
            .collect(),
        validations: value
            .validations
            .iter()
            .map(|validation| wire::AgentValidationResult {
                command_or_check: validation.command_or_check.clone(),
                status: validation.status.clone(),
                tool_call_id: validation.tool_call_id.clone(),
                evidence_ref: validation.evidence_ref.as_ref().map(ToString::to_string),
            })
            .collect(),
        findings: value
            .findings
            .iter()
            .map(|finding| wire::AgentFinding {
                severity: finding.severity.clone(),
                claim: finding.claim.clone(),
                evidence_refs: finding
                    .evidence_refs
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            })
            .collect(),
        blockers: value.blockers.clone(),
        unresolved: value.unresolved.clone(),
        recommended_next_actions: value.recommended_next_actions.clone(),
        confidence: value.confidence.map(|confidence| match confidence {
            domain::Confidence::Low => wire::AgentConfidence::Low,
            domain::Confidence::Medium => wire::AgentConfidence::Medium,
            domain::Confidence::High => wire::AgentConfidence::High,
        }),
        review_verdict: value.review_verdict.map(|verdict| match verdict {
            domain::AgentReviewVerdict::Approved => wire::AgentReviewVerdict::Approved,
            domain::AgentReviewVerdict::ChangesRequested => {
                wire::AgentReviewVerdict::ChangesRequested
            }
            domain::AgentReviewVerdict::Blocked => wire::AgentReviewVerdict::Blocked,
        }),
        artifact_refs: value
            .artifact_refs
            .iter()
            .map(ToString::to_string)
            .collect(),
        usage: usage_contract(value.usage),
    }
}

pub(crate) const fn budget_contract(value: domain::AgentBudget) -> wire::AgentBudget {
    wire::AgentBudget {
        input_tokens: value.input_tokens,
        output_tokens: value.output_tokens,
        provider_cost_micros: value.provider_cost_micros,
        tool_calls: value.tool_calls,
        model_visible_tool_result_bytes: value.model_visible_tool_result_bytes,
        command_wall_time_ms: value.command_wall_time_ms,
        wall_time_ms: value.wall_time_ms,
        files_read: value.files_read,
        files_written: value.files_written,
        child_agents: value.child_agents,
    }
}

pub(crate) const fn usage_contract(value: domain::AgentUsage) -> wire::AgentUsage {
    wire::AgentUsage {
        input_tokens: value.input_tokens,
        output_tokens: value.output_tokens,
        provider_cost_micros: value.provider_cost_micros,
        tool_calls: value.tool_calls,
        model_visible_tool_result_bytes: value.model_visible_tool_result_bytes,
        command_wall_time_ms: value.command_wall_time_ms,
        wall_time_ms: value.wall_time_ms,
        files_read: value.files_read,
        files_written: value.files_written,
        child_agents: value.child_agents,
    }
}

fn task_contract(value: &domain::DelegatedTask) -> wire::DelegatedTask {
    wire::DelegatedTask {
        task_id: value.task_id.to_string(),
        title: value.title.clone(),
        objective: value.objective.clone(),
        known_facts: value.known_facts.clone(),
        success_criteria: value.success_criteria.clone(),
        non_goals: value.non_goals.clone(),
        dependencies: value.dependencies.iter().map(ToString::to_string).collect(),
        context_refs: value.context_refs.iter().map(ToString::to_string).collect(),
        validation_expectations: value.validation_expectations.clone(),
        expected_result_schema: wire::AgentResultSchema {
            version: value.expected_result_schema.version,
            required_fields: value.expected_result_schema.required_fields.clone(),
        },
    }
}

const fn policy_contract(value: &domain::AgentPolicy) -> wire::AgentPolicy {
    wire::AgentPolicy {
        can_delegate: value.can_delegate,
        can_write: value.can_write,
        can_use_network: value.can_use_network,
        can_delete: value.can_delete,
        can_install_dependencies: value.can_install_dependencies,
        can_git_push: value.can_git_push,
        can_ask_user: value.can_ask_user,
        max_depth: value.max_depth,
        max_direct_children: value.max_direct_children,
        max_root_agents: value.max_root_agents,
    }
}

fn workspace_contract(value: &domain::WorkspaceAssignment) -> wire::WorkspaceAssignment {
    wire::WorkspaceAssignment {
        mode: match value.mode {
            domain::WorkspaceMode::RootWorkspace => wire::WorkspaceMode::RootWorkspace,
            domain::WorkspaceMode::SharedReadonly => wire::WorkspaceMode::SharedReadonly,
            domain::WorkspaceMode::IsolatedWorktree => wire::WorkspaceMode::IsolatedWorktree,
            domain::WorkspaceMode::IsolatedSnapshotPatch => {
                wire::WorkspaceMode::IsolatedSnapshotPatch
            }
        },
        root: value.root.clone(),
        read_scope: value.read_scope.clone(),
        write_scope: value.write_scope.clone(),
        baseline_revision: value.baseline_revision.clone(),
        baseline_manifest: value.baseline_manifest.clone(),
        integration_policy: value.integration_policy.clone(),
    }
}
