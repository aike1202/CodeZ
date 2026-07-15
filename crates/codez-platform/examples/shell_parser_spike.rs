use std::{
    env,
    error::Error,
    fs,
    io::{self, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

type MainResult<T = ()> = Result<T, Box<dyn Error>>;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ShellKind {
    Bash,
    Powershell,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusEntry {
    id: String,
    shell: ShellKind,
    command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    executable: String,
    dynamic: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseResult {
    id: String,
    shell: ShellKind,
    has_error: bool,
    operations: Vec<Operation>,
}

fn corpus_path() -> MainResult<PathBuf> {
    let mut arguments = env::args_os().skip(1);
    let path = arguments.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: shell_parser_spike <corpus.json>",
        )
    })?;
    if arguments.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "shell_parser_spike accepts exactly one corpus path",
        )
        .into());
    }
    Ok(path.into())
}

fn collect_command_nodes<'tree>(node: Node<'tree>, output: &mut Vec<Node<'tree>>) {
    if node.kind() == "command" {
        output.push(node);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_command_nodes(child, output);
    }
}

fn tokenize_words(source: &str, shell: ShellKind) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;

    for character in source.trim().chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        let is_escape = matches!(shell, ShellKind::Bash) && character == '\\'
            || matches!(shell, ShellKind::Powershell) && character == '`';
        if is_escape {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') && quote.is_none() {
            quote = Some(character);
            continue;
        }
        if quote == Some(character) {
            quote = None;
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(character);
    }

    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn strip_leading_bash_assignments(arguments: Vec<String>) -> Vec<String> {
    let command_index = arguments.iter().position(|argument| {
        let Some((name, _)) = argument.split_once('=') else {
            return true;
        };
        let mut characters = name.chars();
        characters
            .next()
            .is_none_or(|first| !(first == '_' || first.is_ascii_alphabetic()))
            || characters.any(|character| !(character == '_' || character.is_ascii_alphanumeric()))
    });
    command_index.map_or_else(Vec::new, |index| {
        arguments.into_iter().skip(index).collect()
    })
}

fn normalize_executable(raw: &str) -> String {
    let name = raw
        .trim_matches(['\'', '"'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".ps1", ".sh"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(&name)
        .to_owned()
}

fn paired_marker(value: &str, marker: char) -> bool {
    value
        .find(marker)
        .is_some_and(|start| value[start + marker.len_utf8()..].contains(marker))
}

fn has_dynamic_shell_wrapper_body(arguments: &[String]) -> bool {
    let executable = arguments
        .first()
        .map(|value| normalize_executable(value))
        .unwrap_or_default();
    let body = match executable.as_str() {
        "bash" | "sh" | "zsh" => arguments
            .iter()
            .position(|argument| {
                argument.starts_with('-')
                    && argument[1..]
                        .chars()
                        .all(|character| character.is_ascii_alphabetic())
                    && argument[1..].contains('c')
            })
            .and_then(|index| arguments.get(index + 1))
            .cloned(),
        "powershell" | "pwsh" => arguments
            .iter()
            .position(|argument| {
                matches!(argument.to_ascii_lowercase().as_str(), "-command" | "-c")
            })
            .map(|index| arguments[index + 1..].join(" ")),
        "cmd" => arguments
            .iter()
            .position(|argument| matches!(argument.to_ascii_lowercase().as_str(), "/c" | "/k"))
            .map(|index| arguments[index + 1..].join(" ")),
        _ => None,
    };

    body.as_deref().is_some_and(|body| {
        body.contains('$')
            || body.contains('`')
            || paired_marker(body, '%')
            || paired_marker(body, '!')
    })
}

fn operation(source: &str, shell: ShellKind) -> Operation {
    let raw_arguments = tokenize_words(source, shell);
    let arguments = match shell {
        ShellKind::Bash => strip_leading_bash_assignments(raw_arguments),
        ShellKind::Powershell
            if matches!(raw_arguments.first().map(String::as_str), Some("&" | ".")) =>
        {
            raw_arguments.into_iter().skip(1).collect()
        }
        ShellKind::Powershell => raw_arguments,
    };
    let executable = arguments
        .first()
        .map(|value| normalize_executable(value))
        .unwrap_or_default();
    let dynamic = arguments.is_empty()
        || arguments
            .first()
            .is_some_and(|value| value.contains(['$', '(', ')', '`']))
        || has_dynamic_shell_wrapper_body(&arguments);
    Operation {
        executable,
        dynamic,
    }
}

fn parse_entry(entry: CorpusEntry, parser: &mut Parser) -> MainResult<ParseResult> {
    let tree = parser.parse(&entry.command, None).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "tree-sitter returned no syntax tree",
        )
    })?;
    let root = tree.root_node();
    let mut nodes = Vec::new();
    collect_command_nodes(root, &mut nodes);
    let operations = nodes
        .into_iter()
        .filter_map(|node| entry.command.get(node.byte_range()))
        .map(|source| operation(source.trim(), entry.shell))
        .collect();
    Ok(ParseResult {
        id: entry.id,
        shell: entry.shell,
        has_error: root.has_error(),
        operations,
    })
}

fn main() -> MainResult {
    let corpus = fs::read_to_string(corpus_path()?)?;
    let entries: Vec<CorpusEntry> = serde_json::from_str(&corpus)?;

    let mut bash_parser = Parser::new();
    bash_parser.set_language(&tree_sitter_bash::LANGUAGE.into())?;
    let mut powershell_parser = Parser::new();
    powershell_parser.set_language(&tree_sitter_powershell::LANGUAGE.into())?;

    let mut results = Vec::with_capacity(entries.len());
    for entry in entries {
        let parser = match entry.shell {
            ShellKind::Bash => &mut bash_parser,
            ShellKind::Powershell => &mut powershell_parser,
        };
        results.push(parse_entry(entry, parser)?);
    }

    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer_pretty(&mut output, &results)?;
    output.write_all(b"\n")?;
    Ok(())
}
