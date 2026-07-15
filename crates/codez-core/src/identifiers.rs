use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdentifierError {
    #[error("identifier cannot be empty")]
    Empty,
    #[error("identifier exceeds the maximum length of 160 bytes")]
    TooLong,
}

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
                let value = value.into();
                if value.is_empty() {
                    return Err(IdentifierError::Empty);
                }
                if value.len() > 160 {
                    return Err(IdentifierError::TooLong);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

identifier!(SessionId);
identifier!(StreamId);
identifier!(ToolCallId);

#[cfg(test)]
mod tests {
    use super::{IdentifierError, SessionId};

    #[test]
    fn identifiers_reject_empty_values() {
        assert_eq!(SessionId::parse(""), Err(IdentifierError::Empty));
    }

    #[test]
    fn identifiers_preserve_valid_values() {
        let id = SessionId::parse("session_123").expect("fixture is valid");

        assert_eq!(id.as_str(), "session_123");
    }
}
