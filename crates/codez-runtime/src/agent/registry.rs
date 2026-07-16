use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentOutputField {
    pub name: String,
    pub r#type: String, // 'string' | 'string[]' | 'number' | 'boolean' | 'reviewFinding[]'
    pub description: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentOutputSpec {
    pub description: String,
    pub fields: Vec<SubAgentOutputField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentDefinition {
    pub r#type: String,
    pub name: String,
    pub description: String,

    pub when_to_use: String,
    pub when_not_to_use: Option<String>,
    pub cost_hint: Option<String>,

    pub max_loops: usize,
    pub can_run_in_background: Option<bool>,
    pub isolation: Option<String>,

    pub output_spec: Option<SubAgentOutputSpec>,
}

pub fn get_builtin_subagents() -> Vec<SubAgentDefinition> {
    vec![
        SubAgentDefinition {
            r#type: "Explore".to_string(),
            name: "Explore".to_string(),
            description: "Fast read-only agent specialized in finding files, searching code, and answering questions about a codebase.".to_string(),
            when_to_use: [
                "Use Explore for broad codebase exploration or deep research when a directed search is insufficient.",
                "Use it when the task clearly requires multiple search strategies or more than a few dependent queries.",
                "Specify quick, normal, or exhaustive depth based on the breadth required."
            ].join("\n"),
            when_not_to_use: Some([
                "A direct Glob, Grep, or Read call can answer the question quickly.",
                "The answer is already available in the parent context.",
                "The task requires modifying files, implementing changes, or running state-changing commands.",
                "The task is to review or verify completed changes; use Reviewer instead."
            ].join("\n")),
            cost_hint: Some("Uses configured candidate models and otherwise follows the main Agent. Budgets: quick 8, normal 16, default 24, exhaustive 32 loops.".to_string()),
            max_loops: 24,
            can_run_in_background: None,
            isolation: None,
            output_spec: Some(SubAgentOutputSpec {
                description: "Submit the completed exploration as a Markdown handoff for the parent Agent.".to_string(),
                fields: vec![
                    SubAgentOutputField { name: "report".to_string(), r#type: "string".to_string(), description: "Concise Markdown report with the direct answer, evidence, and relevant file/line references.".to_string(), required: true },
                    SubAgentOutputField { name: "conclusion".to_string(), r#type: "string".to_string(), description: "One concise sentence stating the direct answer.".to_string(), required: true },
                    SubAgentOutputField { name: "confidence".to_string(), r#type: "string".to_string(), description: "Exactly \"high\", \"medium\", or \"low\".".to_string(), required: true },
                    SubAgentOutputField { name: "filesExamined".to_string(), r#type: "string[]".to_string(), description: "Workspace paths actually inspected.".to_string(), required: true },
                    SubAgentOutputField { name: "unresolvedCount".to_string(), r#type: "number".to_string(), description: "Number of requested questions that remain unresolved.".to_string(), required: true },
                ]
            }),
        },
        SubAgentDefinition {
            r#type: "Reviewer".to_string(),
            name: "Reviewer".to_string(),
            description: "Independent read-only reviewer that audits completed changes against the original user goal and returns an evidence-backed verdict.".to_string(),
            when_to_use: [
                "After implementation changes are complete and primary checks have run, before reporting completion to the user.",
                "To independently audit changed code, configuration, resources, tests, or implementation of a plan/specification.",
                "After an initial BLOCKED verdict, resume that same Reviewer exactly once in closure mode after fixing confirmed blockers."
            ].join("\n"),
            when_not_to_use: Some([
                "General codebase exploration, research, or implementation work.",
                "Before the parent Agent has completed the change and gathered the actual changed-file list.",
                "As a substitute for the parent Agent running proportionate primary verification.",
                "Pure question answering or read-only investigation where no project files changed."
            ].join("\n")),
            cost_hint: Some("Up to 24 review tool calls. Uses configured candidate models and otherwise follows the main Agent model.".to_string()),
            max_loops: 24,
            can_run_in_background: None,
            isolation: None,
            output_spec: Some(SubAgentOutputSpec {
                description: "Submit the independent review verdict, findings, and verification evidence.".to_string(),
                fields: vec![
                    SubAgentOutputField { name: "verdict".to_string(), r#type: "string".to_string(), description: "Exactly \"PASS\", \"PASS_WITH_RISKS\", or \"BLOCKED\".".to_string(), required: true },
                    SubAgentOutputField { name: "reviewCycleId".to_string(), r#type: "string".to_string(), description: "Exact caller-provided review cycle ID.".to_string(), required: true },
                    SubAgentOutputField { name: "reviewMode".to_string(), r#type: "string".to_string(), description: "Exact caller-provided mode: \"initial\" or \"closure\".".to_string(), required: true },
                    SubAgentOutputField { name: "report".to_string(), r#type: "string".to_string(), description: "Findings-first review with expected versus actual behavior and supporting evidence.".to_string(), required: true },
                    SubAgentOutputField { name: "conclusion".to_string(), r#type: "string".to_string(), description: "One concise sentence stating the outcome and required next action.".to_string(), required: true },
                    SubAgentOutputField { name: "confidence".to_string(), r#type: "string".to_string(), description: "\"high\", \"medium\", or \"low\".".to_string(), required: true },
                    SubAgentOutputField { name: "blockingFindings".to_string(), r#type: "reviewFinding[]".to_string(), description: "Only high-confidence P0/P1 violations of frozen acceptance criteria with complete evidence.".to_string(), required: true },
                    SubAgentOutputField { name: "risks".to_string(), r#type: "string[]".to_string(), description: "Non-blocking P2/P3 concerns, suggestions, limitations, and incomplete verification.".to_string(), required: true },
                    SubAgentOutputField { name: "resolvedFindingIds".to_string(), r#type: "string[]".to_string(), description: "Original finding IDs proven closed during closure review; empty during initial review.".to_string(), required: true },
                    SubAgentOutputField { name: "checksRun".to_string(), r#type: "string[]".to_string(), description: "Read-only inspections and supplied verification evidence examined; include BLOCKED reasons.".to_string(), required: true },
                    SubAgentOutputField { name: "filesExamined".to_string(), r#type: "string[]".to_string(), description: "Files, plans, and specifications actually examined.".to_string(), required: true },
                    SubAgentOutputField { name: "unresolvedCount".to_string(), r#type: "number".to_string(), description: "Number of review questions that remain unresolved.".to_string(), required: true },
                ]
            }),
        },
        SubAgentDefinition {
            r#type: "ExecutionPlanner".to_string(),
            name: "ExecutionPlanner".to_string(),
            description: "Analyzes an approved plan and groups its steps into parallel execution waves based on file and logical dependencies. Read-only.".to_string(),
            when_to_use: [
                "A plan is approved and the user wants to execute its steps in parallel.",
                "You need to determine which plan steps can safely run concurrently."
            ].join("\n"),
            when_not_to_use: Some([
                "The plan has only 1-2 steps (parallel overhead not worth it).",
                "Steps are strictly sequential (each depends on the previous)."
            ].join("\n")),
            cost_hint: Some("Up to 8 read-only tool calls. Reads the plan and spot-checks files to confirm independence.".to_string()),
            max_loops: 8,
            can_run_in_background: None,
            isolation: None,
            output_spec: Some(SubAgentOutputSpec {
                description: "Submit a Markdown execution-plan handoff plus the machine-readable grouping.".to_string(),
                fields: vec![
                    SubAgentOutputField { name: "report".to_string(), r#type: "string".to_string(), description: "Markdown handoff summarizing wave order, dependencies, file collision risks, and isolation reasoning.".to_string(), required: true },
                    SubAgentOutputField { name: "conclusion".to_string(), r#type: "string".to_string(), description: "One concise sentence stating the recommended grouping and isolation mode.".to_string(), required: true },
                    SubAgentOutputField { name: "confidence".to_string(), r#type: "string".to_string(), description: "Exactly \"high\", \"medium\", or \"low\".".to_string(), required: true },
                    SubAgentOutputField { name: "waves".to_string(), r#type: "string[]".to_string(), description: "Ordered waves. Each entry is a JSON string like {\"index\":0,\"stepIds\":[\"p1\",\"p2\"]}. Steps in the same wave run in parallel; waves run in order.".to_string(), required: true },
                    SubAgentOutputField { name: "isolation".to_string(), r#type: "string".to_string(), description: "\"shared\" if steps in every wave touch disjoint files, \"worktree\" if any risk of write collision".to_string(), required: true },
                    SubAgentOutputField { name: "rationale".to_string(), r#type: "string".to_string(), description: "One sentence explaining the grouping decision".to_string(), required: true },
                ]
            }),
        },
        SubAgentDefinition {
            r#type: "Executor".to_string(),
            name: "Executor".to_string(),
            description: "Executes a single plan step end-to-end: reads context, writes/edits code, and reports what changed. Runs in parallel with sibling executors in the same wave.".to_string(),
            when_to_use: "Executing one independent step of an approved plan.".to_string(),
            when_not_to_use: Some([
                "The step depends on another step not yet completed.",
                "The step touches files a sibling executor is editing in the same wave."
            ].join("\n")),
            cost_hint: Some("Up to 20 tool calls including file edits. One executor per plan step.".to_string()),
            max_loops: 20,
            can_run_in_background: Some(true),
            isolation: Some("none".to_string()),
            output_spec: Some(SubAgentOutputSpec {
                description: "Submit a Markdown implementation handoff plus the machine-readable execution outcome.".to_string(),
                fields: vec![
                    SubAgentOutputField { name: "report".to_string(), r#type: "string".to_string(), description: "Markdown handoff describing changes, verification performed, blockers, and relevant file paths.".to_string(), required: true },
                    SubAgentOutputField { name: "conclusion".to_string(), r#type: "string".to_string(), description: "One concise sentence stating whether the assigned step is complete.".to_string(), required: true },
                    SubAgentOutputField { name: "confidence".to_string(), r#type: "string".to_string(), description: "Exactly \"high\", \"medium\", or \"low\".".to_string(), required: true },
                    SubAgentOutputField { name: "status".to_string(), r#type: "string".to_string(), description: "\"completed\" if the step is fully done, \"failed\" if blocked".to_string(), required: true },
                    SubAgentOutputField { name: "summary".to_string(), r#type: "string".to_string(), description: "One-paragraph summary of what you changed and why".to_string(), required: true },
                    SubAgentOutputField { name: "filesModified".to_string(), r#type: "string[]".to_string(), description: "Paths of files you created or edited".to_string(), required: true },
                    SubAgentOutputField { name: "blockers".to_string(), r#type: "string[]".to_string(), description: "If failed: what blocked you (e.g. needed to touch a file outside your set)".to_string(), required: false },
                ]
            }),
        },
    ]
}
