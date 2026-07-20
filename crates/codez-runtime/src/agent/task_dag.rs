use std::collections::{HashMap, HashSet};

use codez_core::TaskId;
use codez_core::agent::{AgentNode, AgentState, DelegatedTask};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskReadiness {
    Ready,
    Waiting,
    Blocked(Vec<TaskId>),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TaskDagError {
    #[error("task identifier {0} is registered more than once in the root run")]
    DuplicateTask(String),
    #[error("task dependency {dependency} referenced by {task} was not found")]
    MissingDependency { task: String, dependency: String },
    #[error("task dependency graph contains a cycle involving {0}")]
    Cycle(String),
}

pub struct TaskDagPlanner;

impl TaskDagPlanner {
    pub fn validate<'a>(
        existing: impl Iterator<Item = &'a AgentNode>,
        new_tasks: &'a [DelegatedTask],
    ) -> Result<(), TaskDagError> {
        let mut tasks = HashMap::new();
        for task in existing.map(|node| &node.task).chain(new_tasks.iter()) {
            if tasks.insert(task.task_id.clone(), task).is_some() {
                return Err(TaskDagError::DuplicateTask(task.task_id.to_string()));
            }
        }
        for task in tasks.values() {
            for dependency in &task.dependencies {
                if !tasks.contains_key(dependency) {
                    return Err(TaskDagError::MissingDependency {
                        task: task.task_id.to_string(),
                        dependency: dependency.to_string(),
                    });
                }
            }
        }
        let mut visiting = HashSet::new();
        let mut visited = HashSet::new();
        for task_id in tasks.keys() {
            visit(task_id, &tasks, &mut visiting, &mut visited)?;
        }
        Ok(())
    }

    pub fn readiness<'a>(
        task: &DelegatedTask,
        nodes: impl Iterator<Item = &'a AgentNode>,
    ) -> Result<TaskReadiness, TaskDagError> {
        if task.dependencies.is_empty() {
            return Ok(TaskReadiness::Ready);
        }
        let states = nodes
            .map(|node| (node.task.task_id.clone(), node.state))
            .collect::<HashMap<_, _>>();
        let mut waiting = false;
        let mut blocked = Vec::new();
        for dependency in &task.dependencies {
            let state = states
                .get(dependency)
                .ok_or_else(|| TaskDagError::MissingDependency {
                    task: task.task_id.to_string(),
                    dependency: dependency.to_string(),
                })?;
            match state {
                AgentState::Completed => {}
                state if state.is_terminal() => blocked.push(dependency.clone()),
                _ => waiting = true,
            }
        }
        if !blocked.is_empty() {
            Ok(TaskReadiness::Blocked(blocked))
        } else if waiting {
            Ok(TaskReadiness::Waiting)
        } else {
            Ok(TaskReadiness::Ready)
        }
    }
}

fn visit(
    task_id: &TaskId,
    tasks: &HashMap<TaskId, &DelegatedTask>,
    visiting: &mut HashSet<TaskId>,
    visited: &mut HashSet<TaskId>,
) -> Result<(), TaskDagError> {
    if visited.contains(task_id) {
        return Ok(());
    }
    if !visiting.insert(task_id.clone()) {
        return Err(TaskDagError::Cycle(task_id.to_string()));
    }
    let task = tasks
        .get(task_id)
        .ok_or_else(|| TaskDagError::MissingDependency {
            task: task_id.to_string(),
            dependency: task_id.to_string(),
        })?;
    for dependency in &task.dependencies {
        visit(dependency, tasks, visiting, visited)?;
    }
    visiting.remove(task_id);
    visited.insert(task_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use codez_core::TaskId;
    use codez_core::agent::{DelegatedTask, ResultSchema};

    use super::{TaskDagError, TaskDagPlanner};

    #[test]
    fn validate_should_reject_a_dependency_cycle() {
        let tasks = [task("a", &["b"]), task("b", &["a"])];

        let error = TaskDagPlanner::validate(std::iter::empty(), &tasks)
            .expect_err("cyclic tasks must be rejected");

        assert!(matches!(error, TaskDagError::Cycle(_)));
    }

    #[test]
    fn validate_should_reject_a_missing_dependency() {
        let tasks = [task("a", &["missing"])];

        let error = TaskDagPlanner::validate(std::iter::empty(), &tasks)
            .expect_err("missing dependencies must be rejected");

        assert!(matches!(error, TaskDagError::MissingDependency { .. }));
    }

    fn task(id: &str, dependencies: &[&str]) -> DelegatedTask {
        DelegatedTask {
            task_id: TaskId::parse(id).expect("fixture task ID must parse"),
            title: id.to_string(),
            objective: id.to_string(),
            known_facts: Vec::new(),
            success_criteria: Vec::new(),
            non_goals: Vec::new(),
            dependencies: dependencies
                .iter()
                .map(|dependency| {
                    TaskId::parse(*dependency).expect("fixture dependency ID must parse")
                })
                .collect(),
            context_refs: Vec::new(),
            validation_expectations: Vec::new(),
            expected_result_schema: ResultSchema::default(),
        }
    }
}
