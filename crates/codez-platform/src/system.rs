use std::time::SystemTime;

use codez_core::{Clock, IdGenerator};

/// Production wall clock injected through the application composition root.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// Random UUID generator used before parsing IDs into domain-specific newtypes.
#[derive(Debug, Clone, Copy, Default)]
pub struct UuidGenerator;

impl IdGenerator for UuidGenerator {
    fn next_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

#[cfg(test)]
mod tests {
    use codez_core::IdGenerator;

    use super::UuidGenerator;

    #[test]
    fn generated_ids_are_distinct_and_parse_as_uuid() {
        let generator = UuidGenerator;
        let first = generator.next_id();
        let second = generator.next_id();

        assert_ne!(first, second);
        assert!(uuid::Uuid::parse_str(&first).is_ok());
    }
}
