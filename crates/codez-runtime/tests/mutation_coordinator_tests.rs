use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::time::sleep;
use codez_runtime::mutation_coordinator::FileMutationCoordinator;

#[tokio::test]
async fn test_mutation_coordinator_serializes_same_file() {
    let coordinator = Arc::new(FileMutationCoordinator::new());
    let path = PathBuf::from("test.txt");
    let active_count = Arc::new(AtomicUsize::new(0));

    let t1 = {
        let coord = coordinator.clone();
        let path = path.clone();
        let active = active_count.clone();
        tokio::spawn(async move {
            let _guard = coord.acquire(&path).await;
            let cnt = active.fetch_add(1, Ordering::SeqCst);
            assert_eq!(cnt, 0, "No other task should be active for the same file");
            sleep(Duration::from_millis(50)).await;
            active.fetch_sub(1, Ordering::SeqCst);
        })
    };

    let t2 = {
        let coord = coordinator.clone();
        let path = path.clone();
        let active = active_count.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(10)).await;
            let _guard = coord.acquire(&path).await;
            let cnt = active.fetch_add(1, Ordering::SeqCst);
            assert_eq!(cnt, 0, "No other task should be active for the same file");
            sleep(Duration::from_millis(50)).await;
            active.fetch_sub(1, Ordering::SeqCst);
        })
    };

    let _ = tokio::try_join!(t1, t2).unwrap();
}

#[tokio::test]
async fn test_mutation_coordinator_allows_parallel_different_files() {
    let coordinator = Arc::new(FileMutationCoordinator::new());
    let path1 = PathBuf::from("test1.txt");
    let path2 = PathBuf::from("test2.txt");

    let barrier = Arc::new(tokio::sync::Barrier::new(2));

    let t1 = {
        let coord = coordinator.clone();
        let b = barrier.clone();
        tokio::spawn(async move {
            let _guard = coord.acquire(&path1).await;
            b.wait().await;
        })
    };

    let t2 = {
        let coord = coordinator.clone();
        let b = barrier.clone();
        tokio::spawn(async move {
            let _guard = coord.acquire(&path2).await;
            b.wait().await;
        })
    };

    let _ = tokio::time::timeout(Duration::from_secs(1), async { tokio::try_join!(t1, t2).unwrap() })
        .await
        .expect("Timeout: tasks did not run in parallel");
}
