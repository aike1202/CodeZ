use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use codez_core::agent::{
    AGENT_SCHEMA_VERSION, AgentBudget, AgentCompletionPolicy, AgentPolicy, AgentProfile,
    AgentResult, AgentResultStatus, AgentState, AgentUsage, DelegatedTask, MessageKind,
    ResultSchema, WorkspaceAssignment, WorkspaceMode,
};
use codez_core::{
    AgentAttemptId, AgentId, ArtifactId, CancellationToken, Clock, IdGenerator, RootRunId, TaskId,
    provider::{AgentStopReason, ChatMessage, ProviderTokenUsage, Role, ToolDefinition},
};
use codez_runtime::agent::{
    AgentArtifactStore, AgentBudgetManager, AgentControlStore, AgentExecutionContext,
    AgentExecutionEvent, AgentExecutionEventSink, AgentExecutor, AgentLedgerPort, AgentPortError,
    AgentPromptPort, AgentPromptRequest, AgentPromptSnapshot, AgentProviderPort,
    AgentProviderRequest, AgentProviderTurn, AgentScheduler, AgentSupervisor,
    AgentSupervisorConfig, AgentToolBatchResult, AgentToolPort, AgentToolResult,
    AgentTurnControlPort, AgentTurnDirective, DurableMailbox, MailboxAck, ScheduledAgent,
    SchedulerConfig, SendAgentMessageInput, SpawnAgentInput, SpawnAgentRequest, SupervisorError,
};
use codez_storage::AtomicFileStore;
use tempfile::TempDir;

#[derive(Default)]
struct SequenceIds {
    next: AtomicU64,
}

impl IdGenerator for SequenceIds {
    fn next_id(&self) -> String {
        self.next.fetch_add(1, Ordering::Relaxed).to_string()
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_750_000_000)
    }
}

struct RuntimeFixture {
    _temp: TempDir,
    supervisor: Arc<AgentSupervisor>,
    store: Arc<AgentControlStore>,
    mailbox: Arc<DurableMailbox>,
    scheduler: Arc<AgentScheduler>,
    artifacts: Arc<AgentArtifactStore>,
    persistence: Arc<AtomicFileStore>,
    runtime_root: std::path::PathBuf,
}

impl RuntimeFixture {
    fn new(config: AgentSupervisorConfig) -> Self {
        let temp = tempfile::tempdir().expect("temporary runtime root must be available");
        let runtime_root = temp.path().join("agent-runtime");
        let persistence = Arc::new(AtomicFileStore::default());
        let persistence_port: Arc<dyn codez_core::AtomicPersistence> = persistence.clone();
        let store = Arc::new(AgentControlStore::new(
            &runtime_root,
            Arc::clone(&persistence_port),
        ));
        let mailbox = Arc::new(DurableMailbox::new(
            &runtime_root,
            Arc::clone(&persistence_port),
        ));
        let scheduler = Arc::new(AgentScheduler::new(SchedulerConfig::default()));
        let artifacts = Arc::new(AgentArtifactStore::new(
            runtime_root.join("artifacts"),
            Arc::clone(&persistence_port),
        ));
        let supervisor = Arc::new(
            AgentSupervisor::new(
                config,
                Arc::clone(&store),
                Arc::clone(&mailbox),
                Arc::clone(&scheduler),
                Arc::new(AgentBudgetManager::new()),
                Arc::new(FixedClock),
                Arc::new(SequenceIds::default()),
            )
            .with_artifact_store(Arc::clone(&artifacts)),
        );
        Self {
            _temp: temp,
            supervisor,
            store,
            mailbox,
            scheduler,
            artifacts,
            persistence,
            runtime_root,
        }
    }

    async fn running_root(&self) -> (RootRunId, AgentId, AgentAttemptId) {
        let root_run_id = RootRunId::parse("root-test").expect("fixture root id is valid");
        let root = self
            .supervisor
            .start_root_attempt_direct(root_run_id.clone(), root_input())
            .await
            .expect("root registration must succeed");
        self.supervisor
            .transition(
                &root_run_id,
                &root.agent_id,
                &root.attempt_id,
                1,
                AgentState::Starting,
            )
            .await
            .expect("root must start");
        self.supervisor
            .transition(
                &root_run_id,
                &root.agent_id,
                &root.attempt_id,
                2,
                AgentState::Running,
            )
            .await
            .expect("root must run");
        (root_run_id, root.agent_id, root.attempt_id)
    }
}

#[tokio::test]
async fn spawn_should_return_one_agent_when_the_same_tool_call_is_replayed_ten_times() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let request = SpawnAgentRequest {
        root_run_id: root_run_id.clone(),
        parent_agent_id: root_agent_id,
        parent_attempt_id: root_attempt_id,
        tool_call_id: "tool-call-1".to_string(),
        agents: vec![readonly_child("child-task")],
    };
    let first = fixture
        .supervisor
        .spawn_agents(request.clone())
        .await
        .expect("first spawn must succeed");

    for _ in 0..9 {
        let replayed = fixture
            .supervisor
            .spawn_agents(request.clone())
            .await
            .expect("idempotent spawn replay must succeed");
        assert_eq!(replayed[0].agent_id, first[0].agent_id);
    }
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("control ledger must replay");

    assert_eq!(snapshot.nodes.len(), 2);
}

#[tokio::test]
async fn concurrent_spawn_replay_should_queue_only_the_persisted_agent() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let request = SpawnAgentRequest {
        root_run_id: root_run_id.clone(),
        parent_agent_id: root_agent_id,
        parent_attempt_id: root_attempt_id,
        tool_call_id: "tool-call-concurrent-replay".to_string(),
        agents: vec![readonly_child("concurrent-child-task")],
    };

    let (first, second) = tokio::join!(
        fixture.supervisor.spawn_agents(request.clone()),
        fixture.supervisor.spawn_agents(request)
    );
    let first = first.expect("first concurrent spawn must succeed");
    let second = second.expect("second concurrent spawn must replay");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("concurrent spawn ledger must replay");

    assert_eq!(
        (
            first[0].agent_id.clone(),
            snapshot.nodes.len(),
            fixture.scheduler.queued_len(),
        ),
        (second[0].agent_id.clone(), 2, 1)
    );
}

#[tokio::test]
async fn supervisor_should_deny_direct_sibling_messages() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let children = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-sibling-acl".to_string(),
            agents: vec![readonly_child("sibling-a"), readonly_child("sibling-b")],
        })
        .await
        .expect("sibling Agents must register");

    let error = fixture
        .supervisor
        .send_message(SendAgentMessageInput {
            root_run_id,
            from: children[0].agent_id.clone(),
            to: children[1].agent_id.clone(),
            kind: MessageKind::Finding,
            summary: "Bypass the parent route.".to_string(),
            correlation_id: None,
            reply_to: None,
            idempotency_key: None,
            artifact_refs: Vec::new(),
        })
        .await
        .expect_err("siblings must communicate through their parent");

    assert!(matches!(error, SupervisorError::MessageAclDenied));
}

#[tokio::test]
async fn oversized_message_should_persist_an_artifact_and_deliver_only_a_summary() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-large-message-child".to_string(),
            agents: vec![readonly_child("large-message-child")],
        })
        .await
        .expect("message recipient must register")
        .remove(0);
    let content = "evidence:".to_string() + &"x".repeat(4_096);

    let message = fixture
        .supervisor
        .send_message(SendAgentMessageInput {
            root_run_id: root_run_id.clone(),
            from: root_agent_id.clone(),
            to: child.agent_id,
            kind: MessageKind::Finding,
            summary: content.clone(),
            correlation_id: None,
            reply_to: None,
            idempotency_key: Some("large-message".to_string()),
            artifact_refs: Vec::new(),
        })
        .await
        .expect("large message must be converted to an artifact");
    let artifacts = fixture
        .artifacts
        .list_for_agent(&root_run_id, &root_agent_id, usize::MAX)
        .await
        .expect("message artifact must be discoverable");

    assert!(message.summary.len() < 2 * 1024);
    assert_eq!(message.artifact_refs.len(), 1);
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].artifact_id, message.artifact_refs[0]);
    assert_eq!(artifacts[0].preview.as_deref(), Some(content.as_str()));
}

#[tokio::test]
async fn supervisor_should_enforce_direct_child_limit() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig {
        max_direct_children: 1,
        ..AgentSupervisorConfig::default()
    });
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id.clone(),
            tool_call_id: "tool-call-first-child".to_string(),
            agents: vec![readonly_child("first-child")],
        })
        .await
        .expect("first child must register");

    let error = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id,
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-extra-child".to_string(),
            agents: vec![readonly_child("extra-child")],
        })
        .await
        .expect_err("direct child limit must reject another child");

    assert!(matches!(error, SupervisorError::DirectChildLimit));
}

#[tokio::test]
async fn supervisor_should_enforce_root_agent_limit() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig {
        max_root_agents: 2,
        ..AgentSupervisorConfig::default()
    });
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id.clone(),
            tool_call_id: "tool-call-root-limit-first".to_string(),
            agents: vec![readonly_child("root-limit-first")],
        })
        .await
        .expect("first child must fit the root limit");

    let error = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id,
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-root-limit-extra".to_string(),
            agents: vec![readonly_child("root-limit-extra")],
        })
        .await
        .expect_err("root Agent limit must include the root node");

    assert!(matches!(error, SupervisorError::RootAgentLimit));
}

#[tokio::test]
async fn supervisor_should_enforce_depth_limit_at_the_tool_boundary() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig {
        max_depth: 1,
        ..AgentSupervisorConfig::default()
    });
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let mut delegated = readonly_child("delegating-child");
    delegated.policy.can_delegate = true;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-delegating-child".to_string(),
            agents: vec![delegated],
        })
        .await
        .expect("depth-one child must register")
        .remove(0);
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("child must start");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("child must run");

    let error = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id,
            parent_agent_id: child.agent_id,
            parent_attempt_id: child.attempt_id,
            tool_call_id: "tool-call-grandchild".to_string(),
            agents: vec![readonly_child("grandchild")],
        })
        .await
        .expect_err("depth-two delegation must be denied by the configured limit");

    assert!(matches!(error, SupervisorError::DepthLimit));
}

#[tokio::test]
async fn child_policy_should_remain_an_intersection_of_parent_and_request() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let mut requested = readonly_child("network-child");
    requested.policy.can_use_network = true;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-policy-intersection".to_string(),
            agents: vec![requested],
        })
        .await
        .expect("child must register")
        .remove(0);
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("policy snapshot must replay");

    assert!(!snapshot.nodes[&child.agent_id].policy.can_use_network);
}

#[tokio::test]
async fn supervisor_should_allow_a_full_capability_child_in_the_root_workspace() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let root_run_id = RootRunId::parse("root-writable-clone").expect("root ID must parse");
    let mut root = root_input();
    root.workspace = WorkspaceAssignment {
        mode: WorkspaceMode::RootWorkspace,
        root: fixture._temp.path().to_string_lossy().into_owned(),
        read_scope: vec!["**/*".to_string()],
        write_scope: vec!["**/*".to_string()],
        baseline_revision: None,
        baseline_manifest: None,
        integration_policy: "direct_serial".to_string(),
    };
    root.policy.can_write = true;
    root.policy.can_delete = true;
    root.policy.can_use_network = true;
    root.policy.can_install_dependencies = true;
    root.policy.can_git_push = true;
    root.policy.can_ask_user = true;
    let root = fixture
        .supervisor
        .start_root_attempt_direct(root_run_id.clone(), root)
        .await
        .expect("writable root must register");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &root.agent_id,
            &root.attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("root must start");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &root.agent_id,
            &root.attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("root must run");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("root snapshot must load");
    let root_node = snapshot.nodes[&root.agent_id].clone();
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root.agent_id,
            parent_attempt_id: root.attempt_id,
            tool_call_id: "spawn-writable-clone".to_string(),
            agents: vec![SpawnAgentInput {
                root_session_id: None,
                task: task("writable-clone-task"),
                profile: AgentProfile::General,
                workspace: root_node.workspace.clone(),
                policy: root_node.policy.clone(),
                budget: AgentBudget::conservative_child(),
                provider_id: "provider".to_string(),
                model_id: "model".to_string(),
            }],
        })
        .await
        .expect("full-capability child must register")
        .remove(0);
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("child snapshot must load");
    let child_node = &snapshot.nodes[&child.agent_id];

    assert_eq!(
        (
            child_node.workspace.mode,
            child_node.workspace.root.as_str(),
            &child_node.policy,
        ),
        (
            WorkspaceMode::RootWorkspace,
            root_node.workspace.root.as_str(),
            &root_node.policy,
        )
    );
}

#[tokio::test]
async fn fail_fast_batch_should_cancel_unfinished_siblings_after_a_failure() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let children = fixture
        .supervisor
        .spawn_agents_with_policy(
            SpawnAgentRequest {
                root_run_id: root_run_id.clone(),
                parent_agent_id: root_agent_id,
                parent_attempt_id: root_attempt_id,
                tool_call_id: "tool-call-fail-fast".to_string(),
                agents: vec![readonly_child("fail-fast-a"), readonly_child("fail-fast-b")],
            },
            AgentCompletionPolicy::FailFast,
        )
        .await
        .expect("fail-fast children must register");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &children[0].agent_id,
            &children[0].attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("failing child must start");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &children[0].agent_id,
            &children[0].attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("failing child must run");
    fixture
        .supervisor
        .submit_result(
            &root_run_id,
            &children[0].agent_id,
            &children[0].attempt_id,
            failed_result("stop the batch"),
        )
        .await
        .expect("failing child result must persist");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("fail-fast state must replay");

    assert_eq!(
        snapshot.nodes[&children[1].agent_id].state,
        AgentState::Cancelled
    );
}

#[tokio::test]
async fn terminal_transition_should_choose_only_one_winner_during_complete_cancel_race() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let completed = fixture.supervisor.transition(
        &root_run_id,
        &root_agent_id,
        &root_attempt_id,
        3,
        AgentState::Completed,
    );
    let cancelled = fixture.supervisor.transition(
        &root_run_id,
        &root_agent_id,
        &root_attempt_id,
        3,
        AgentState::Cancelled,
    );
    let (completed, cancelled) = tokio::join!(completed, cancelled);

    assert_ne!(completed.is_ok(), cancelled.is_ok());
}

#[tokio::test]
async fn mailbox_wait_should_observe_a_message_sent_before_listener_registration() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-mailbox".to_string(),
            agents: vec![readonly_child("mailbox-child")],
        })
        .await
        .expect("child spawn must succeed")
        .remove(0);
    fixture
        .supervisor
        .send_message(SendAgentMessageInput {
            root_run_id: root_run_id.clone(),
            from: root_agent_id,
            to: child.agent_id.clone(),
            kind: MessageKind::Instruction,
            summary: "Inspect the frozen contract.".to_string(),
            correlation_id: None,
            reply_to: None,
            idempotency_key: Some("instruction-1".to_string()),
            artifact_refs: Vec::<ArtifactId>::new(),
        })
        .await
        .expect("message must persist before notification");

    let messages = fixture
        .mailbox
        .wait_after(
            &root_run_id,
            &child.agent_id,
            0,
            10,
            Duration::from_millis(10),
        )
        .await
        .expect("persisted message must be replayed");

    assert_eq!(messages.len(), 1);
}

#[tokio::test]
async fn mailbox_ack_should_remain_idempotent_after_store_reconstruction() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id,
            tool_call_id: "tool-call-ack".to_string(),
            agents: vec![readonly_child("ack-child")],
        })
        .await
        .expect("child spawn must succeed")
        .remove(0);
    let message = fixture
        .supervisor
        .send_message(SendAgentMessageInput {
            root_run_id: root_run_id.clone(),
            from: root_agent_id,
            to: child.agent_id.clone(),
            kind: MessageKind::Instruction,
            summary: "Use this instruction once.".to_string(),
            correlation_id: None,
            reply_to: None,
            idempotency_key: Some("instruction-once".to_string()),
            artifact_refs: Vec::new(),
        })
        .await
        .expect("message must persist");
    let persistence: Arc<dyn codez_core::AtomicPersistence> = fixture.persistence.clone();
    let restarted = DurableMailbox::new(&fixture.runtime_root, persistence);
    let ack = MailboxAck {
        message_id: message.id,
        attempt_id: child.attempt_id,
        acknowledged_at: "2026-07-19T00:00:00Z".to_string(),
    };
    restarted
        .ack(&root_run_id, ack.clone(), "ack-1".to_string())
        .await
        .expect("first ack must persist");

    assert!(
        !restarted
            .ack(&root_run_id, ack, "ack-2".to_string())
            .await
            .expect("duplicate ack must be handled")
    );
}

#[tokio::test]
async fn scheduler_should_keep_root_jobs_in_round_robin_order() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    fixture.scheduler.enqueue(scheduled("root-a", "agent-a1"));
    fixture.scheduler.enqueue(scheduled("root-a", "agent-a2"));
    fixture.scheduler.enqueue(scheduled("root-b", "agent-b1"));
    let order = [
        fixture.scheduler.next().await.agent_id.to_string(),
        fixture.scheduler.next().await.agent_id.to_string(),
        fixture.scheduler.next().await.agent_id.to_string(),
    ];

    assert_eq!(order, ["agent-a1", "agent-b1", "agent-a2"]);
}

#[tokio::test]
async fn task_dag_should_queue_agents_one_wave_after_each_dependency_completes() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let handles = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "spawn-dag-waves".to_string(),
            agents: vec![
                child_with_dependencies("task-a", &[]),
                child_with_dependencies("task-b", &["task-a"]),
                child_with_dependencies("task-c", &["task-b"]),
            ],
        })
        .await
        .expect("valid task DAG must register");

    assert_eq!(
        handles
            .iter()
            .map(|handle| handle.state)
            .collect::<Vec<_>>(),
        [AgentState::Queued, AgentState::Created, AgentState::Created]
    );
    assert_eq!(fixture.scheduler.queued_len(), 1);
    let first = fixture.scheduler.next().await;
    assert_eq!(first.agent_id, handles[0].agent_id);
    run_and_complete(&fixture, &first, "task A completed").await;

    assert_eq!(fixture.scheduler.queued_len(), 1);
    let second = fixture.scheduler.next().await;
    assert_eq!(second.agent_id, handles[1].agent_id);
    let dependency_messages = fixture
        .mailbox
        .list_after(&root_run_id, &second.agent_id, 0, 10)
        .await
        .expect("dependency context must load");
    assert!(dependency_messages.iter().any(|message| {
        message.kind == MessageKind::SystemNotice && message.summary.contains("task-a")
    }));
    run_and_complete(&fixture, &second, "task B completed").await;

    assert_eq!(fixture.scheduler.queued_len(), 1);
    let third = fixture.scheduler.next().await;
    assert_eq!(third.agent_id, handles[2].agent_id);
}

#[tokio::test]
async fn task_dag_should_block_all_downstream_agents_after_a_dependency_fails() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let handles = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id,
            parent_attempt_id: root_attempt_id,
            tool_call_id: "spawn-dag-failure".to_string(),
            agents: vec![
                child_with_dependencies("failure-a", &[]),
                child_with_dependencies("failure-b", &["failure-a"]),
                child_with_dependencies("failure-c", &["failure-b"]),
            ],
        })
        .await
        .expect("valid task DAG must register");
    let first = fixture.scheduler.next().await;
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &first.agent_id,
            &first.attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("first dependency must start");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &first.agent_id,
            &first.attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("first dependency must run");
    fixture
        .supervisor
        .submit_result(
            &root_run_id,
            &first.agent_id,
            &first.attempt_id,
            failed_result("dependency failed"),
        )
        .await
        .expect("dependency failure must propagate");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("blocked DAG must replay");

    assert_eq!(
        snapshot.nodes[&handles[1].agent_id].state,
        AgentState::Blocked
    );
    assert_eq!(
        snapshot.nodes[&handles[2].agent_id].state,
        AgentState::Blocked
    );
    assert_eq!(
        snapshot.results[&handles[2].attempt_id].status,
        AgentResultStatus::Blocked
    );
    assert_eq!(fixture.scheduler.queued_len(), 0);
}

#[tokio::test]
async fn executor_should_run_a_root_attempt_with_fake_provider_and_persist_completion() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let root_run_id = RootRunId::parse("root-executor").expect("fixture root id is valid");
    let root = fixture
        .supervisor
        .register_root(root_run_id.clone(), root_input())
        .await
        .expect("root registration must succeed");
    let provider = Arc::new(ScriptedProvider::new(vec![AgentProviderTurn {
        content: "Executor completed the task.".to_string(),
        tool_calls: Vec::new(),
        usage: Some(ProviderTokenUsage {
            input_tokens: 120,
            output_tokens: 30,
            reasoning_tokens: None,
            total_tokens: Some(150),
        }),
        stop_reason: Some(AgentStopReason::Stop),
    }]));
    let executor = AgentExecutor::new(
        Arc::clone(&fixture.supervisor),
        provider,
        Arc::new(NoTools),
        Arc::new(MemoryLedger::default()),
        Arc::new(StaticPrompt),
        Arc::new(MemoryEvents::default()),
    );

    let outcome = executor
        .execute(
            ScheduledAgent {
                root_run_id: root_run_id.clone(),
                agent_id: root.agent_id.clone(),
                attempt_id: root.attempt_id,
                provider_id: "provider".to_string(),
            },
            CancellationToken::new(),
        )
        .await
        .expect("fake provider attempt must complete");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("completed control ledger must replay");

    assert_eq!(
        (
            outcome.result.status,
            snapshot
                .nodes
                .get(&root.agent_id)
                .expect("root node remains persisted")
                .state,
            snapshot
                .current_attempt(&root.agent_id)
                .expect("root attempt remains persisted")
                .usage
                .input_tokens,
        ),
        (
            codez_core::agent::AgentResultStatus::Completed,
            AgentState::Completed,
            120,
        )
    );
}

#[tokio::test]
async fn root_completion_should_cancel_every_unfinished_child_subtree() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id.clone(),
            tool_call_id: "tool-call-unjoined-child".to_string(),
            agents: vec![readonly_child("unjoined-child")],
        })
        .await
        .expect("unfinished child must register")
        .remove(0);
    let provider = Arc::new(ScriptedProvider::new(vec![AgentProviderTurn {
        content: "Root ended without joining its child.".to_string(),
        tool_calls: Vec::new(),
        usage: None,
        stop_reason: Some(AgentStopReason::Stop),
    }]));
    let executor = AgentExecutor::new(
        Arc::clone(&fixture.supervisor),
        provider,
        Arc::new(NoTools),
        Arc::new(MemoryLedger::default()),
        Arc::new(StaticPrompt),
        Arc::new(MemoryEvents::default()),
    );

    executor
        .execute(
            ScheduledAgent {
                root_run_id: root_run_id.clone(),
                agent_id: root_agent_id,
                attempt_id: root_attempt_id,
                provider_id: "provider".to_string(),
            },
            CancellationToken::new(),
        )
        .await
        .expect("root completion must succeed after cancelling unfinished children");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("root completion ledger must replay");

    assert_eq!(snapshot.nodes[&child.agent_id].state, AgentState::Cancelled);
}

#[tokio::test]
async fn executor_should_continue_after_a_root_turn_when_control_consumes_a_steer() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let root_run_id = RootRunId::parse("root-steer").expect("fixture root id is valid");
    let root = fixture
        .supervisor
        .register_root(root_run_id.clone(), root_input())
        .await
        .expect("root registration must succeed");
    let provider = Arc::new(ScriptedProvider::new(vec![
        AgentProviderTurn {
            content: "Initial answer.".to_string(),
            tool_calls: Vec::new(),
            usage: None,
            stop_reason: Some(AgentStopReason::Stop),
        },
        AgentProviderTurn {
            content: "Answer after steer.".to_string(),
            tool_calls: Vec::new(),
            usage: None,
            stop_reason: Some(AgentStopReason::Stop),
        },
    ]));
    let executor = AgentExecutor::new(
        Arc::clone(&fixture.supervisor),
        provider,
        Arc::new(NoTools),
        Arc::new(MemoryLedger::default()),
        Arc::new(StaticPrompt),
        Arc::new(MemoryEvents::default()),
    )
    .with_turn_control(Arc::new(ContinueOnce::default()));

    let outcome = executor
        .execute(
            ScheduledAgent {
                root_run_id,
                agent_id: root.agent_id,
                attempt_id: root.attempt_id,
                provider_id: "provider".to_string(),
            },
            CancellationToken::new(),
        )
        .await
        .expect("steered root attempt must complete");

    assert_eq!(outcome.final_content, "Answer after steer.");
}

#[tokio::test]
async fn startup_recovery_should_mark_persisted_nonterminal_attempts_interrupted() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let restarted = AgentSupervisor::new(
        AgentSupervisorConfig::default(),
        Arc::clone(&fixture.store),
        Arc::clone(&fixture.mailbox),
        Arc::new(AgentScheduler::new(SchedulerConfig::default())),
        Arc::new(AgentBudgetManager::new()),
        Arc::new(FixedClock),
        Arc::new(SequenceIds::default()),
    );

    let recovered = restarted
        .recover_orphaned_attempts()
        .await
        .expect("startup recovery must scan persisted roots");
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("recovered control ledger must load");

    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].agent_id, root_agent_id);
    assert_eq!(recovered[0].attempt_id, root_attempt_id);
    assert_eq!(recovered[0].state, AgentState::Interrupted);
    assert_eq!(
        snapshot.nodes[&root_agent_id].state,
        AgentState::Interrupted
    );
}

#[tokio::test]
async fn followup_should_replay_the_same_attempt_for_one_tool_call_id() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id,
            tool_call_id: "spawn-child".to_string(),
            agents: vec![readonly_child("initial-child-task")],
        })
        .await
        .expect("child spawn must succeed")
        .remove(0);
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("child must start");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("child must run");
    let failure = failed_result("retry this assignment");
    fixture
        .supervisor
        .submit_result(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            failure.clone(),
        )
        .await
        .expect("child failure must release its reservation");
    fixture
        .supervisor
        .submit_result(&root_run_id, &child.agent_id, &child.attempt_id, failure)
        .await
        .expect("result submission replay must remain idempotent");
    let result_messages = fixture
        .mailbox
        .list_after(&root_run_id, &root_agent_id, 0, 10)
        .await
        .expect("parent mailbox must load result projection");
    assert_eq!(result_messages.len(), 1);
    assert_eq!(result_messages[0].kind, MessageKind::Result);

    let first = fixture
        .supervisor
        .start_followup_attempt(
            &root_run_id,
            &child.agent_id,
            "followup-call",
            readonly_child("followup-task"),
        )
        .await
        .expect("follow-up attempt must be created");
    for _ in 0..9 {
        let replayed = fixture
            .supervisor
            .start_followup_attempt(
                &root_run_id,
                &child.agent_id,
                "followup-call",
                readonly_child("followup-task"),
            )
            .await
            .expect("follow-up replay must be idempotent");
        assert_eq!(replayed.attempt_id, first.attempt_id);
        assert!(!replayed.created);
    }
    let snapshot = fixture
        .store
        .load(&root_run_id)
        .await
        .expect("follow-up control ledger must load");
    assert_eq!(
        snapshot
            .attempts
            .values()
            .filter(|attempt| attempt.agent_id == child.agent_id)
            .count(),
        2
    );
}

#[tokio::test]
async fn user_followup_should_start_after_restart_when_the_parent_is_terminal() {
    let fixture = RuntimeFixture::new(AgentSupervisorConfig::default());
    let (root_run_id, root_agent_id, root_attempt_id) = fixture.running_root().await;
    let child = fixture
        .supervisor
        .spawn_agents(SpawnAgentRequest {
            root_run_id: root_run_id.clone(),
            parent_agent_id: root_agent_id.clone(),
            parent_attempt_id: root_attempt_id.clone(),
            tool_call_id: "spawn-user-followup".to_string(),
            agents: vec![readonly_child("user-followup-child")],
        })
        .await
        .expect("child spawn must succeed")
        .remove(0);
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("child must start");
    fixture
        .supervisor
        .transition(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("child must run");
    fixture
        .supervisor
        .submit_result(
            &root_run_id,
            &child.agent_id,
            &child.attempt_id,
            failed_result("inspect again"),
        )
        .await
        .expect("child result must persist");
    fixture
        .supervisor
        .submit_result(
            &root_run_id,
            &root_agent_id,
            &root_attempt_id,
            completed_result("root finished"),
        )
        .await
        .expect("root result must persist");
    let restarted = AgentSupervisor::new(
        AgentSupervisorConfig::default(),
        Arc::clone(&fixture.store),
        Arc::clone(&fixture.mailbox),
        Arc::new(AgentScheduler::new(SchedulerConfig::default())),
        Arc::new(AgentBudgetManager::new()),
        Arc::new(FixedClock),
        Arc::new(SequenceIds::default()),
    );
    restarted
        .recover_orphaned_attempts()
        .await
        .expect("startup must reconstruct persisted budget usage");

    let handle = restarted
        .start_user_followup_attempt(
            &root_run_id,
            &child.agent_id,
            "ui-followup",
            readonly_child("user-followup-child"),
        )
        .await
        .expect("user follow-up must not require a running parent");

    assert_eq!(handle.state, AgentState::Queued);
}

struct ScriptedProvider {
    turns: tokio::sync::Mutex<VecDeque<AgentProviderTurn>>,
}

impl ScriptedProvider {
    fn new(turns: Vec<AgentProviderTurn>) -> Self {
        Self {
            turns: tokio::sync::Mutex::new(turns.into()),
        }
    }
}

#[async_trait]
impl AgentProviderPort for ScriptedProvider {
    async fn run_turn(
        &self,
        request: AgentProviderRequest,
        events: &dyn AgentExecutionEventSink,
        _cancellation: CancellationToken,
    ) -> Result<AgentProviderTurn, AgentPortError> {
        let turn =
            self.turns.lock().await.pop_front().ok_or_else(|| {
                AgentPortError::new("SCRIPT_EXHAUSTED", "no scripted turn", false)
            })?;
        events.publish(
            &request.context,
            AgentExecutionEvent::AssistantDelta(turn.content.clone()),
        );
        Ok(turn)
    }
}

struct NoTools;

#[async_trait]
impl AgentToolPort for NoTools {
    async fn definitions(
        &self,
        _context: &AgentExecutionContext,
        _finalization_required: bool,
    ) -> Result<Vec<ToolDefinition>, AgentPortError> {
        Ok(Vec::new())
    }

    async fn execute(
        &self,
        _context: &AgentExecutionContext,
        _calls: Vec<codez_core::provider::ToolCall>,
        _cancellation: CancellationToken,
    ) -> Result<AgentToolBatchResult, AgentPortError> {
        Ok(AgentToolBatchResult {
            results: Vec::<AgentToolResult>::new(),
            submitted_result: None,
        })
    }
}

#[derive(Default)]
struct MemoryLedger {
    messages: tokio::sync::Mutex<Vec<ChatMessage>>,
}

#[async_trait]
impl AgentLedgerPort for MemoryLedger {
    async fn load_messages(
        &self,
        _context: &AgentExecutionContext,
    ) -> Result<Vec<ChatMessage>, AgentPortError> {
        Ok(self.messages.lock().await.clone())
    }

    async fn append_assistant(
        &self,
        _context: &AgentExecutionContext,
        turn: &AgentProviderTurn,
    ) -> Result<(), AgentPortError> {
        self.messages.lock().await.push(ChatMessage {
            role: Role::Assistant,
            content: Some(turn.content.clone()),
            tool_calls: (!turn.tool_calls.is_empty()).then(|| turn.tool_calls.clone()),
            tool_call_id: None,
            name: None,
            images: Vec::new(),
        });
        Ok(())
    }

    async fn append_tool_result(
        &self,
        _context: &AgentExecutionContext,
        result: &AgentToolResult,
    ) -> Result<(), AgentPortError> {
        self.messages.lock().await.push(ChatMessage {
            role: Role::Tool,
            content: Some(result.model_content.clone()),
            tool_calls: None,
            tool_call_id: Some(result.call_id.clone()),
            name: Some(result.name.clone()),
            images: Vec::new(),
        });
        Ok(())
    }
}

struct StaticPrompt;

#[async_trait]
impl AgentPromptPort for StaticPrompt {
    async fn compose(
        &self,
        _request: AgentPromptRequest,
    ) -> Result<AgentPromptSnapshot, AgentPortError> {
        Ok(AgentPromptSnapshot {
            text: "System prompt".to_string(),
            schema_version: AGENT_SCHEMA_VERSION,
            module_hashes: vec!["module-hash".to_string()],
            dynamic_snapshot_hash: "dynamic-hash".to_string(),
            result_contract_version: AGENT_SCHEMA_VERSION,
        })
    }
}

#[derive(Default)]
struct ContinueOnce {
    calls: AtomicU64,
}

#[async_trait]
impl AgentTurnControlPort for ContinueOnce {
    async fn after_assistant(
        &self,
        _context: &AgentExecutionContext,
        _turn: &AgentProviderTurn,
    ) -> Result<AgentTurnDirective, AgentPortError> {
        Ok(if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            AgentTurnDirective::Continue
        } else {
            AgentTurnDirective::Finish
        })
    }
}

#[derive(Default)]
struct MemoryEvents {
    events: std::sync::Mutex<Vec<AgentExecutionEvent>>,
}

impl AgentExecutionEventSink for MemoryEvents {
    fn publish(&self, _context: &AgentExecutionContext, event: AgentExecutionEvent) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event);
    }
}

fn root_input() -> SpawnAgentInput {
    let mut policy = AgentPolicy::readonly_child();
    policy.can_delegate = true;
    policy.max_root_agents = 12;
    SpawnAgentInput {
        root_session_id: Some(
            codez_core::SessionId::parse("session-test").expect("fixture session id is valid"),
        ),
        task: task("root-task"),
        profile: AgentProfile::General,
        workspace: readonly_workspace(),
        policy,
        budget: root_budget(),
        provider_id: "provider".to_string(),
        model_id: "model".to_string(),
    }
}

fn readonly_child(task_id: &str) -> SpawnAgentInput {
    SpawnAgentInput {
        root_session_id: None,
        task: task(task_id),
        profile: AgentProfile::Explore,
        workspace: readonly_workspace(),
        policy: AgentPolicy::readonly_child(),
        budget: AgentBudget::conservative_child(),
        provider_id: "provider".to_string(),
        model_id: "model".to_string(),
    }
}

fn child_with_dependencies(task_id: &str, dependencies: &[&str]) -> SpawnAgentInput {
    let mut child = readonly_child(task_id);
    child.task.dependencies = dependencies
        .iter()
        .map(|dependency| {
            TaskId::parse(*dependency).expect("fixture dependency task ID must parse")
        })
        .collect();
    child
}

async fn run_and_complete(fixture: &RuntimeFixture, job: &ScheduledAgent, summary: &str) {
    fixture
        .supervisor
        .transition(
            &job.root_run_id,
            &job.agent_id,
            &job.attempt_id,
            1,
            AgentState::Starting,
        )
        .await
        .expect("DAG task must start");
    fixture
        .supervisor
        .transition(
            &job.root_run_id,
            &job.agent_id,
            &job.attempt_id,
            2,
            AgentState::Running,
        )
        .await
        .expect("DAG task must run");
    fixture
        .supervisor
        .submit_result(
            &job.root_run_id,
            &job.agent_id,
            &job.attempt_id,
            completed_result(summary),
        )
        .await
        .expect("DAG task must complete");
}

fn task(id: &str) -> DelegatedTask {
    DelegatedTask {
        task_id: TaskId::parse(id).expect("fixture task id is valid"),
        title: id.to_string(),
        objective: "Produce evidence.".to_string(),
        known_facts: Vec::new(),
        success_criteria: vec!["Return a result.".to_string()],
        non_goals: Vec::new(),
        dependencies: Vec::new(),
        context_refs: Vec::new(),
        validation_expectations: Vec::new(),
        expected_result_schema: ResultSchema {
            version: AGENT_SCHEMA_VERSION,
            required_fields: vec!["summary".to_string()],
        },
    }
}

fn readonly_workspace() -> WorkspaceAssignment {
    WorkspaceAssignment {
        mode: WorkspaceMode::SharedReadonly,
        root: std::env::temp_dir().to_string_lossy().to_string(),
        read_scope: vec!["**/*".to_string()],
        write_scope: Vec::new(),
        baseline_revision: None,
        baseline_manifest: None,
        integration_policy: "none".to_string(),
    }
}

fn root_budget() -> AgentBudget {
    let child = AgentBudget::conservative_child();
    AgentBudget {
        input_tokens: child.input_tokens * 12,
        output_tokens: child.output_tokens * 12,
        provider_cost_micros: child.provider_cost_micros * 12,
        tool_calls: child.tool_calls * 12,
        model_visible_tool_result_bytes: child.model_visible_tool_result_bytes * 12,
        command_wall_time_ms: child.command_wall_time_ms * 12,
        wall_time_ms: child.wall_time_ms * 12,
        files_read: child.files_read * 12,
        files_written: child.files_written * 12,
        child_agents: 12,
    }
}

fn failed_result(message: &str) -> AgentResult {
    AgentResult {
        status: AgentResultStatus::Failed,
        summary: message.to_string(),
        conclusion: None,
        changes: Vec::new(),
        validations: Vec::new(),
        findings: Vec::new(),
        blockers: vec![message.to_string()],
        unresolved: Vec::new(),
        recommended_next_actions: Vec::new(),
        confidence: None,
        review_verdict: None,
        artifact_refs: Vec::new(),
        usage: AgentUsage::default(),
    }
}

fn completed_result(message: &str) -> AgentResult {
    AgentResult {
        status: AgentResultStatus::Completed,
        summary: message.to_string(),
        conclusion: Some(message.to_string()),
        changes: Vec::new(),
        validations: Vec::new(),
        findings: Vec::new(),
        blockers: Vec::new(),
        unresolved: Vec::new(),
        recommended_next_actions: Vec::new(),
        confidence: None,
        review_verdict: None,
        artifact_refs: Vec::new(),
        usage: AgentUsage::default(),
    }
}

fn scheduled(root: &str, agent: &str) -> ScheduledAgent {
    ScheduledAgent {
        root_run_id: RootRunId::parse(root).expect("fixture root id is valid"),
        agent_id: AgentId::parse(agent).expect("fixture agent id is valid"),
        attempt_id: AgentAttemptId::parse(format!("attempt-{agent}"))
            .expect("fixture attempt id is valid"),
        provider_id: "provider".to_string(),
    }
}
