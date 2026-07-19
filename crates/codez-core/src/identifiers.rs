use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdentifierError {
    #[error("identifier cannot be empty")]
    Empty,
    #[error("identifier exceeds the maximum length of 160 bytes")]
    TooLong,
    #[error("identifier is not a filesystem-safe segment")]
    UnsafeFilesystemSegment,
    #[error("identifier uses a reserved Windows device name")]
    ReservedWindowsName,
}

const MAX_IDENTIFIER_BYTES: usize = 160;

fn validate_identifier(value: &str) -> Result<(), IdentifierError> {
    if value.is_empty() {
        return Err(IdentifierError::Empty);
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(IdentifierError::TooLong);
    }
    Ok(())
}

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
                let value = value.into();
                validate_identifier(&value)?;
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    /// Parses a session identifier that can safely be used as one file-name segment.
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] for empty, oversized, path-like, non-portable,
    /// or Windows-reserved values.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
        let value = value.into();
        validate_identifier(&value)?;
        validate_filesystem_segment(&value)?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SessionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(D::Error::custom)
    }
}

fn validate_filesystem_segment(value: &str) -> Result<(), IdentifierError> {
    let is_portable_character =
        |character: char| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.');
    if value.starts_with('.')
        || value.ends_with('.')
        || value.contains("..")
        || !value.chars().all(is_portable_character)
    {
        return Err(IdentifierError::UnsafeFilesystemSegment);
    }
    if is_reserved_windows_name(value) {
        return Err(IdentifierError::ReservedWindowsName);
    }
    Ok(())
}

fn is_reserved_windows_name(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or(value);
    let uppercase = stem.to_ascii_uppercase();
    matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || uppercase
            .strip_prefix("COM")
            .or_else(|| uppercase.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

identifier!(StreamId);
identifier!(ToolCallId);
identifier!(AgentRunId);
identifier!(ProcessId);
identifier!(RootRunId);
identifier!(AgentId);
identifier!(AgentAttemptId);
identifier!(TaskId);
identifier!(MessageId);
identifier!(ArtifactId);

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

    #[test]
    fn session_identifiers_reject_parent_traversal() {
        assert_eq!(
            SessionId::parse("session..backup"),
            Err(IdentifierError::UnsafeFilesystemSegment)
        );
    }

    #[test]
    fn session_identifiers_reject_path_separators() {
        let candidates = ["../outside", r"..\outside", "/absolute", r"C:\absolute"];

        assert!(candidates.into_iter().all(|value| matches!(
            SessionId::parse(value),
            Err(IdentifierError::UnsafeFilesystemSegment)
        )));
    }

    #[test]
    fn session_identifiers_reject_windows_device_names() {
        let candidates = ["CON", "nul", "COM1", "lpt9.json"];

        assert!(candidates.into_iter().all(|value| matches!(
            SessionId::parse(value),
            Err(IdentifierError::ReservedWindowsName)
        )));
    }

    #[test]
    fn session_identifier_deserialization_enforces_path_safety() {
        let result = serde_json::from_str::<SessionId>(r#""../outside""#);

        assert!(result.is_err());
    }
}
