pub(crate) fn initialize() {
    let _ = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(false)
        .try_init();
}
