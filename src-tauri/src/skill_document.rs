use codez_core::AppError;
use serde::Deserialize;

pub(crate) const MAX_SKILL_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
const MAX_NAME_BYTES: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 8 * 1024;
const MAX_TRIGGERS: usize = 128;
const MAX_TRIGGER_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillDocument {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) triggers: Vec<String>,
    pub(crate) body: String,
}

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    triggers: Vec<String>,
}

pub(crate) fn parse_skill_document_bytes(bytes: &[u8]) -> Result<SkillDocument, AppError> {
    if bytes.len() > MAX_SKILL_DOCUMENT_BYTES {
        return Err(AppError::validation(
            "SKILL.md exceeds the document size limit",
        ));
    }
    let content = std::str::from_utf8(bytes)
        .map_err(|_| AppError::validation("SKILL.md must be valid UTF-8"))?;
    parse_skill_document(content)
}

pub(crate) fn parse_skill_document(content: &str) -> Result<SkillDocument, AppError> {
    if content.len() > MAX_SKILL_DOCUMENT_BYTES {
        return Err(AppError::validation(
            "SKILL.md exceeds the document size limit",
        ));
    }
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (frontmatter, body) = split_frontmatter(content)?;
    if frontmatter.len() > MAX_FRONTMATTER_BYTES {
        return Err(AppError::validation(
            "SKILL.md frontmatter exceeds the size limit",
        ));
    }
    let parsed: SkillFrontmatter = serde_yaml::from_str(frontmatter).map_err(|source| {
        AppError::validation(format!("SKILL.md frontmatter is invalid: {source}"))
    })?;
    let name = normalize_optional(parsed.name);
    let description = normalize_optional(parsed.description);
    if name
        .as_ref()
        .is_some_and(|value| value.len() > MAX_NAME_BYTES)
    {
        return Err(AppError::validation("Skill name exceeds the length limit"));
    }
    if description
        .as_ref()
        .is_some_and(|value| value.len() > MAX_DESCRIPTION_BYTES)
    {
        return Err(AppError::validation(
            "Skill description exceeds the length limit",
        ));
    }
    if parsed.triggers.len() > MAX_TRIGGERS {
        return Err(AppError::validation("Skill has too many triggers"));
    }
    let triggers = parsed
        .triggers
        .into_iter()
        .map(|trigger| trigger.trim().to_string())
        .filter(|trigger| !trigger.is_empty())
        .collect::<Vec<_>>();
    if triggers
        .iter()
        .any(|trigger| trigger.len() > MAX_TRIGGER_BYTES)
    {
        return Err(AppError::validation(
            "Skill trigger exceeds the length limit",
        ));
    }
    Ok(SkillDocument {
        name,
        description,
        triggers,
        body: body.trim().to_string(),
    })
}

fn split_frontmatter(content: &str) -> Result<(&str, &str), AppError> {
    let mut lines = content.split_inclusive('\n');
    let first = lines
        .next()
        .ok_or_else(|| AppError::validation("SKILL.md is empty"))?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return Err(AppError::validation("SKILL.md is missing YAML frontmatter"));
    }
    let start = first.len();
    let mut offset = start;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let body_start = offset
                .checked_add(line.len())
                .ok_or_else(|| AppError::validation("SKILL.md is too large"))?;
            return Ok((&content[start..offset], &content[body_start..]));
        }
        offset = offset
            .checked_add(line.len())
            .ok_or_else(|| AppError::validation("SKILL.md is too large"))?;
    }
    Err(AppError::validation(
        "SKILL.md frontmatter is not terminated",
    ))
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_supports_bom_crlf_and_multiline_yaml() {
        let document = parse_skill_document(
            "\u{feff}---\r\nname: review\r\ndescription: >\r\n  Review code safely.\r\ntriggers: [review, audit]\r\n---\r\nUse Read first.\r\n",
        )
        .expect("valid skill document must parse");

        assert_eq!(
            document,
            SkillDocument {
                name: Some("review".to_string()),
                description: Some("Review code safely.".to_string()),
                triggers: vec!["review".to_string(), "audit".to_string()],
                body: "Use Read first.".to_string(),
            }
        );
    }

    #[test]
    fn parser_rejects_an_unterminated_frontmatter_block() {
        let error = parse_skill_document("---\nname: review\n")
            .expect_err("unterminated frontmatter must fail");
        assert!(error.to_string().contains("not terminated"));
    }

    #[test]
    fn parser_rejects_an_oversized_document_before_yaml_decode() {
        let content = "x".repeat(MAX_SKILL_DOCUMENT_BYTES + 1);
        let error = parse_skill_document(&content).expect_err("oversized skill must fail");
        assert!(error.to_string().contains("size limit"));
    }
}
