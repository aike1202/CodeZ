use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::{SubAgentError, SubAgentRole};

/// A validated provider model identifier selected by the application configuration.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubAgentModelId(String);

impl SubAgentModelId {
    /// Validates a provider model identifier before it is used in a model profile.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::InvalidModelId`] for empty, oversized, padded,
    /// or control-character-containing values.
    pub fn parse(value: impl Into<String>) -> Result<Self, SubAgentError> {
        let value = value.into();
        if !super::types::is_valid_sub_agent_text(&value) {
            return Err(SubAgentError::InvalidModelId);
        }
        Ok(Self(value))
    }

    /// Returns the configured provider model identifier.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SubAgentModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SubAgentModelId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SubAgentModelId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Per-role model limits supplied by application configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentModelProfile {
    model_id: SubAgentModelId,
    token_budget: usize,
    max_tokens: Option<usize>,
}

impl SubAgentModelProfile {
    /// Creates a validated model profile.
    ///
    /// # Errors
    ///
    /// Returns an error when the budget is zero, `max_tokens` is zero or larger
    /// than the total budget, or the model identifier is invalid.
    pub fn new(
        model_id: SubAgentModelId,
        token_budget: usize,
        max_tokens: Option<usize>,
    ) -> Result<Self, SubAgentError> {
        if token_budget == 0 {
            return Err(SubAgentError::InvalidModelTokenBudget);
        }
        if max_tokens.is_some_and(|max_tokens| max_tokens == 0 || max_tokens > token_budget) {
            return Err(SubAgentError::InvalidModelMaxTokens);
        }

        Ok(Self {
            model_id,
            token_budget,
            max_tokens,
        })
    }

    /// Returns the configured provider model identifier.
    #[must_use]
    pub fn model_id(&self) -> &SubAgentModelId {
        &self.model_id
    }

    /// Returns the complete input and output token budget.
    #[must_use]
    pub const fn token_budget(&self) -> usize {
        self.token_budget
    }

    /// Returns the optional output-token ceiling.
    #[must_use]
    pub const fn max_tokens(&self) -> Option<usize> {
        self.max_tokens
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubAgentModelProfile {
    model_id: SubAgentModelId,
    token_budget: usize,
    max_tokens: Option<usize>,
}

impl<'de> Deserialize<'de> for SubAgentModelProfile {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawSubAgentModelProfile::deserialize(deserializer)?;
        Self::new(raw.model_id, raw.token_budget, raw.max_tokens).map_err(serde::de::Error::custom)
    }
}

/// Resolves model profiles that the application has explicitly configured.
///
/// An absent profile remains absent. This layer must not fabricate a default
/// provider or model because it has no credential or provider-selection input.
#[derive(Debug, Clone, Default)]
pub struct SubAgentModelResolver {
    profiles: BTreeMap<SubAgentRole, SubAgentModelProfile>,
}

impl SubAgentModelResolver {
    /// Builds a resolver from explicitly configured role profiles.
    ///
    /// # Errors
    ///
    /// Returns [`SubAgentError::DuplicateModelProfile`] when the input contains
    /// two profiles for the same role.
    pub fn try_from_profiles(
        profiles: impl IntoIterator<Item = (SubAgentRole, SubAgentModelProfile)>,
    ) -> Result<Self, SubAgentError> {
        let mut configured = BTreeMap::new();
        for (role, profile) in profiles {
            if configured.insert(role.clone(), profile).is_some() {
                return Err(SubAgentError::DuplicateModelProfile { role });
            }
        }
        Ok(Self {
            profiles: configured,
        })
    }

    /// Returns the configured profile for a role, if one exists.
    #[must_use]
    pub fn resolve(&self, role: &SubAgentRole) -> Option<&SubAgentModelProfile> {
        self.profiles.get(role)
    }

    /// Inserts or replaces the application-configured profile for a role.
    pub fn upsert(&mut self, role: SubAgentRole, profile: SubAgentModelProfile) {
        self.profiles.insert(role, profile);
    }

    /// Removes and returns the configured profile for a role.
    pub fn remove(&mut self, role: &SubAgentRole) -> Option<SubAgentModelProfile> {
        self.profiles.remove(role)
    }
}

#[cfg(test)]
mod tests {
    use super::{SubAgentModelId, SubAgentModelProfile, SubAgentModelResolver};
    use crate::agent::sub_agent::{SubAgentError, SubAgentRole};

    fn role(value: &str) -> SubAgentRole {
        SubAgentRole::parse(value).expect("test role must be valid")
    }

    fn profile() -> SubAgentModelProfile {
        SubAgentModelProfile::new(
            SubAgentModelId::parse("gpt-5").expect("test model ID must be valid"),
            40_000,
            Some(4_096),
        )
        .expect("test model profile must be valid")
    }

    #[test]
    fn resolve_should_return_only_explicitly_configured_profiles() {
        let resolver = SubAgentModelResolver::try_from_profiles([(role("coder"), profile())])
            .expect("configured profiles should be unique");

        let resolved = resolver.resolve(&role("reviewer"));

        assert!(resolved.is_none());
    }

    #[test]
    fn try_from_profiles_should_reject_duplicate_roles() {
        let error = SubAgentModelResolver::try_from_profiles([
            (role("coder"), profile()),
            (role("coder"), profile()),
        ])
        .expect_err("duplicate role configuration must fail");

        assert_eq!(
            error,
            SubAgentError::DuplicateModelProfile {
                role: role("coder"),
            }
        );
    }

    #[test]
    fn model_profile_should_reject_an_output_limit_larger_than_its_budget() {
        let error = SubAgentModelProfile::new(
            SubAgentModelId::parse("gpt-5").expect("test model ID must be valid"),
            100,
            Some(101),
        )
        .expect_err("output limit cannot exceed the budget");

        assert_eq!(error, SubAgentError::InvalidModelMaxTokens);
    }

    #[test]
    fn model_profile_deserialization_should_reject_a_zero_token_budget() {
        let error = serde_json::from_str::<SubAgentModelProfile>(
            r#"{"modelId":"gpt-5","tokenBudget":0,"maxTokens":null}"#,
        )
        .expect_err("zero token budget must not deserialize");

        assert!(error.to_string().contains("token budget"));
    }
}
