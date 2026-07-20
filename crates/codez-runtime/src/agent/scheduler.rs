use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use codez_core::{AgentAttemptId, AgentId, RootRunId};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerConfig {
    pub global_provider_concurrency: usize,
    pub active_agents_per_root: usize,
    pub provider_concurrency: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            global_provider_concurrency: 4,
            active_agents_per_root: 3,
            provider_concurrency: 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledAgent {
    pub root_run_id: RootRunId,
    pub agent_id: AgentId,
    pub attempt_id: AgentAttemptId,
    pub provider_id: String,
}

#[derive(Default)]
struct FairQueue {
    roots: VecDeque<RootRunId>,
    jobs: HashMap<RootRunId, VecDeque<ScheduledAgent>>,
}

impl FairQueue {
    fn push(&mut self, job: ScheduledAgent) {
        let root_run_id = job.root_run_id.clone();
        let queue = self.jobs.entry(root_run_id.clone()).or_default();
        if queue.is_empty() {
            self.roots.push_back(root_run_id);
        }
        queue.push_back(job);
    }

    fn pop(&mut self) -> Option<ScheduledAgent> {
        let root_run_id = self.roots.pop_front()?;
        let queue = self.jobs.get_mut(&root_run_id)?;
        let job = queue.pop_front();
        if queue.is_empty() {
            self.jobs.remove(&root_run_id);
        } else {
            self.roots.push_back(root_run_id);
        }
        job
    }
}

pub struct AgentScheduler {
    config: SchedulerConfig,
    queue: Mutex<FairQueue>,
    notify: Notify,
    global_provider: Arc<Semaphore>,
    roots: Mutex<HashMap<RootRunId, Arc<Semaphore>>>,
    providers: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl AgentScheduler {
    #[must_use]
    pub fn new(config: SchedulerConfig) -> Self {
        Self {
            config,
            queue: Mutex::new(FairQueue::default()),
            notify: Notify::new(),
            global_provider: Arc::new(Semaphore::new(config.global_provider_concurrency)),
            roots: Mutex::new(HashMap::new()),
            providers: Mutex::new(HashMap::new()),
        }
    }

    pub fn enqueue(&self, job: ScheduledAgent) {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(job);
        self.notify.notify_one();
    }

    pub async fn next(&self) -> ScheduledAgent {
        loop {
            let notified = self.notify.notified();
            if let Some(job) = self
                .queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop()
            {
                return job;
            }
            notified.await;
        }
    }

    pub async fn acquire_provider(
        &self,
        root_run_id: &RootRunId,
        provider_id: &str,
    ) -> Result<ProviderExecutionPermit, tokio::sync::AcquireError> {
        let root = self.root_semaphore(root_run_id);
        let provider = self.provider_semaphore(provider_id);
        let provider = provider.acquire_owned().await?;
        let root = root.acquire_owned().await?;
        let global = Arc::clone(&self.global_provider).acquire_owned().await?;
        Ok(ProviderExecutionPermit {
            _global: global,
            _root: root,
            _provider: provider,
        })
    }

    #[must_use]
    pub fn queued_len(&self) -> usize {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .jobs
            .values()
            .map(VecDeque::len)
            .sum()
    }

    fn root_semaphore(&self, root_run_id: &RootRunId) -> Arc<Semaphore> {
        Arc::clone(
            self.roots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(root_run_id.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(self.config.active_agents_per_root))),
        )
    }

    fn provider_semaphore(&self, provider_id: &str) -> Arc<Semaphore> {
        Arc::clone(
            self.providers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(provider_id.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(self.config.provider_concurrency))),
        )
    }
}

pub struct ProviderExecutionPermit {
    _global: OwnedSemaphorePermit,
    _root: OwnedSemaphorePermit,
    _provider: OwnedSemaphorePermit,
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use codez_core::{AgentAttemptId, AgentId, RootRunId};

    use super::{AgentScheduler, ScheduledAgent, SchedulerConfig};

    fn job(root: &str, agent: &str) -> ScheduledAgent {
        ScheduledAgent {
            root_run_id: RootRunId::parse(root).expect("fixture root id is valid"),
            agent_id: AgentId::parse(agent).expect("fixture agent id is valid"),
            attempt_id: AgentAttemptId::parse(format!("attempt-{agent}"))
                .expect("fixture attempt id is valid"),
            provider_id: "provider".to_string(),
        }
    }

    #[tokio::test]
    async fn queue_should_round_robin_between_roots() {
        let scheduler = AgentScheduler::new(SchedulerConfig::default());
        scheduler.enqueue(job("root-a", "a-1"));
        scheduler.enqueue(job("root-a", "a-2"));
        scheduler.enqueue(job("root-b", "b-1"));

        let order = [
            scheduler.next().await.agent_id.to_string(),
            scheduler.next().await.agent_id.to_string(),
            scheduler.next().await.agent_id.to_string(),
        ];

        assert_eq!(order, ["a-1", "b-1", "a-2"]);
    }

    #[tokio::test]
    async fn dropping_provider_permit_should_release_all_nested_limits() {
        let scheduler = AgentScheduler::new(SchedulerConfig {
            global_provider_concurrency: 1,
            active_agents_per_root: 1,
            provider_concurrency: 1,
        });
        let root = RootRunId::parse("root-a").expect("fixture root id is valid");
        let first = scheduler
            .acquire_provider(&root, "provider")
            .await
            .expect("first permit is available");
        drop(first);

        assert!(scheduler.acquire_provider(&root, "provider").await.is_ok());
    }

    #[tokio::test]
    async fn provider_waiter_should_not_consume_global_capacity_needed_by_another_provider() {
        let scheduler = Arc::new(AgentScheduler::new(SchedulerConfig {
            global_provider_concurrency: 2,
            active_agents_per_root: 2,
            provider_concurrency: 1,
        }));
        let root_a = RootRunId::parse("root-a").expect("fixture root id is valid");
        let root_b = RootRunId::parse("root-b").expect("fixture root id is valid");
        let first = scheduler
            .acquire_provider(&root_a, "provider-a")
            .await
            .expect("first Provider permit is available");
        let waiting_scheduler = Arc::clone(&scheduler);
        let waiting_root = root_a.clone();
        let waiter = tokio::spawn(async move {
            waiting_scheduler
                .acquire_provider(&waiting_root, "provider-a")
                .await
        });
        tokio::task::yield_now().await;

        let independent = tokio::time::timeout(
            Duration::from_secs(1),
            scheduler.acquire_provider(&root_b, "provider-b"),
        )
        .await;

        assert!(independent.is_ok_and(|result| result.is_ok()));
        waiter.abort();
        drop(first);
    }

    #[tokio::test]
    async fn one_hundred_requests_should_not_exceed_the_root_concurrency_limit() {
        let scheduler = Arc::new(AgentScheduler::new(SchedulerConfig {
            global_provider_concurrency: 4,
            active_agents_per_root: 3,
            provider_concurrency: 4,
        }));
        let root = RootRunId::parse("root-stress").expect("fixture root id is valid");
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..100 {
            let scheduler = Arc::clone(&scheduler);
            let root = root.clone();
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            tasks.spawn(async move {
                let permit = scheduler
                    .acquire_provider(&root, "provider")
                    .await
                    .expect("stress permit must eventually be available");
                let now = active.fetch_add(1, Ordering::SeqCst).saturating_add(1);
                maximum.fetch_max(now, Ordering::SeqCst);
                tokio::task::yield_now().await;
                active.fetch_sub(1, Ordering::SeqCst);
                drop(permit);
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.expect("stress worker must complete");
        }

        assert!(maximum.load(Ordering::SeqCst) <= 3);
    }
}
