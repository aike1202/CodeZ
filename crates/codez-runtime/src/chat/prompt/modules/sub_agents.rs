use crate::chat::prompt::types::{PromptContext, PromptLayer, PromptModule};

pub struct SubAgentsModule;

use crate::chat::prompt::types::BoxFuture;

impl PromptModule for SubAgentsModule {
    fn id(&self) -> &'static str {
        "subagents"
    }

    fn layer(&self) -> PromptLayer {
        PromptLayer::Dynamic
    }

    fn priority(&self) -> i32 {
        3
    }

    fn is_enabled<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let has_tool = ctx.available_tools.as_ref().map_or(true, |tools| {
                tools.iter().any(|t| {
                    t.name == "SubAgentRunner" || t.name == "DelegateTasks" || t.name == "spawn_agent"
                })
            });

            // TODO: Port SubAgentManager::listEnabledDefinitions().length > 0
            has_tool
        })
    }

    fn build<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            // TODO: Port SubAgentManager::listEnabledDefinitions() iteration

            let lines = vec![
                "<subagent_guidance>".to_string(),
                "Available specialists:".to_string(),
                "## Independent review gate".to_string(),
                "After completing user-requested code, configuration, migration, or runtime behavior changes, you MUST invoke one fresh Reviewer in initial mode after primary verification and before reporting completion. Documentation-only and plan-only changes use at most one advisory initial review and never enter an automatic fix/review loop.".to_string(),
                "Do not use Explore, your own inspection, or an implementation agent's self-check as a substitute for Reviewer.".to_string(),
                "Give Reviewer a self-contained brief containing:".to_string(),
                "1. Original user goal and a frozen, numbered acceptance-criteria list in expectations.questions. The Reviewer may not add completion criteria.".to_string(),
                "2. Actual changes and implementation approach.".to_string(),
                "3. Complete changed-file list for this request, clearly separated from unrelated pre-existing changes.".to_string(),
                "4. Verification commands already run and their actual results.".to_string(),
                "5. Known risks, unresolved items, and relevant plan or specification paths.".to_string(),
                "Create a stable review_cycle_id for that bounded task or milestone and call review_mode=\"initial\". PASS and PASS_WITH_RISKS are terminal; disclose risks from PASS_WITH_RISKS without launching another Reviewer.".to_string(),
                "Treat BLOCKED findings as candidates, not automatic truth. Fix only findings that cite a frozen AC-N criterion and include a concrete location, expected/actual behavior, reproduction, repository evidence, P0/P1 severity, and high confidence. Batch all confirmed fixes before any follow-up.".to_string(),
                "After confirmed blockers are fixed, resume the same completed Reviewer exactly once with review_mode=\"closure\", the same review_cycle_id, its resume_subagent_id, and all previous_finding_ids. Closure review may only resolve or reopen those IDs and regressions directly caused by their fixes; it must not perform another full audit or add criteria.".to_string(),
                "Closure is terminal even when it remains BLOCKED. Report unresolved blockers or request user/arbiter direction; never launch a third Reviewer or create a fresh review cycle for the same content.".to_string(),
                "If a Reviewer is interrupted or fails for infrastructure reasons, resume that same subagent ID in the same mode. Infrastructure retries do not consume the closure review and must not create a fresh Reviewer.".to_string(),
                "Skip this gate when no behavioral project files changed, such as pure question answering or read-only investigation.".to_string(),
                "For background delegation, spawn_agent returns immediately with an agent ID and path. Use list_agents to inspect status, send_message for additional context, and followup_task only after that Agent is idle.".to_string(),
                "Treat <agent_runtime_state> as authoritative. Call wait_agent only for IDs currently listed there as queued/running, then consume FINAL_ANSWER before finalizing. Never wait for a terminal or absent Agent, and do not treat a successful spawn_agent response as completion.".to_string(),
                "For interrupted or failed runs, use the returned handoff and resume_subagent_id when continuity is useful. Do not repeat confirmed completed work.".to_string(),
                "</subagent_guidance>".to_string(),
            ];
            Some(lines.join("\n"))
        })
    }
}
