use tree_sitter::{Node, Parser};

use crate::permission::shell::types::{
    NormalizedOperation, NormalizedOperationGraph, NormalizedRedirect, PermissionShellKind,
};

const POWERSHELL_NATIVE_COMMANDS: &[&str] = &[
    "ant",
    "ansible",
    "ansible-playbook",
    "bash",
    "bazel",
    "bazelisk",
    "buck",
    "buck2",
    "bun",
    "bundle",
    "bundler",
    "cargo",
    "cmake",
    "composer",
    "deno",
    "docker",
    "dotnet",
    "eslint",
    "gem",
    "git",
    "go",
    "gradle",
    "gradlew",
    "helm",
    "jest",
    "kubectl",
    "make",
    "meson",
    "msbuild",
    "mvn",
    "mvnw",
    "ninja",
    "node",
    "npm",
    "npx",
    "nuget",
    "pnpm",
    "prettier",
    "pwsh",
    "py",
    "pytest",
    "python",
    "python3",
    "rg",
    "ripgrep",
    "rustc",
    "rustup",
    "sbt",
    "sh",
    "swift",
    "terraform",
    "tofu",
    "tsc",
    "uv",
    "vitest",
    "xbuild",
    "xcodebuild",
    "yarn",
    "zsh",
];

const POWERSHELL_ARGUMENT_LIST_COMMANDS: &[&str] = &[
    "format-list",
    "format-table",
    "get-childitem",
    "get-item",
    "new-item",
    "select-object",
    "select-string",
];

const POWERSHELL_SCOPED_PACKAGE_COMMANDS: &[&str] = &["bun", "npm", "npx", "pnpm", "yarn"];

const PURE_POWERSHELL_METHODS: &[&str] = &[
    "compareto",
    "contains",
    "endswith",
    "equals",
    "indexof",
    "join",
    "lastindexof",
    "normalize",
    "replace",
    "split",
    "startswith",
    "substring",
    "tolower",
    "tolowerinvariant",
    "tostring",
    "toupper",
    "toupperinvariant",
    "trim",
    "trimend",
    "trimstart",
];

pub struct ShellCommandParser;

impl ShellCommandParser {
    #[must_use]
    pub fn parse(shell: PermissionShellKind, command: &str) -> NormalizedOperationGraph {
        match shell {
            PermissionShellKind::Cmd => CmdCommandParser::parse(command),
            PermissionShellKind::Bash | PermissionShellKind::Powershell => {
                parse_structured_shell(shell, command)
            }
        }
    }
}

fn parse_structured_shell(shell: PermissionShellKind, command: &str) -> NormalizedOperationGraph {
    let parse_source = match shell {
        PermissionShellKind::Powershell => mask_powershell_parser_quirks(command),
        PermissionShellKind::Bash => mask_bash_windows_paths(command),
        PermissionShellKind::Cmd => command.to_string(),
    };
    let mut parser = Parser::new();
    let language = match shell {
        PermissionShellKind::Bash => tree_sitter_bash::LANGUAGE.into(),
        PermissionShellKind::Powershell => tree_sitter_powershell::LANGUAGE.into(),
        PermissionShellKind::Cmd => unreachable!("CMD parsing uses CmdCommandParser"),
    };
    if parser.set_language(&language).is_err() {
        return unparsed_graph(shell, command, "parser-language");
    }
    let Some(tree) = parser.parse(&parse_source, None) else {
        return unparsed_graph(shell, command, "parser-tree");
    };

    let root = tree.root_node();
    let mut command_nodes = Vec::new();
    collect_nodes(root, "command", &mut command_nodes);
    let operations = command_nodes
        .into_iter()
        .filter_map(|node| command.get(node.byte_range()))
        .map(|source| operation(source.trim(), shell.clone()))
        .collect::<Vec<_>>();
    let mut diagnostics = Vec::new();
    if root.has_error() {
        diagnostics.push("syntax-error".to_string());
    }
    if shell == PermissionShellKind::Powershell {
        collect_powershell_invocation_diagnostics(root, command, &mut diagnostics);
    }
    diagnostics.sort();
    diagnostics.dedup();
    let (operators, redirects) = scan_syntax(command, &shell);

    NormalizedOperationGraph {
        shell,
        source: command.to_string(),
        operations,
        operators,
        redirects,
        diagnostics,
    }
}

fn unparsed_graph(
    shell: PermissionShellKind,
    command: &str,
    diagnostic: &str,
) -> NormalizedOperationGraph {
    NormalizedOperationGraph {
        shell,
        source: command.to_string(),
        operations: Vec::new(),
        operators: Vec::new(),
        redirects: Vec::new(),
        diagnostics: vec![diagnostic.to_string()],
    }
}

fn collect_nodes<'tree>(node: Node<'tree>, kind: &str, output: &mut Vec<Node<'tree>>) {
    if node.kind() == kind {
        output.push(node);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_nodes(child, kind, output);
    }
}

fn collect_powershell_invocation_diagnostics(
    node: Node<'_>,
    source: &str,
    diagnostics: &mut Vec<String>,
) {
    if node.kind() == "invokation_expression" && !powershell_invocation_is_pure(node, source) {
        let invocation = source
            .get(node.byte_range())
            .unwrap_or("<dynamic invocation>")
            .trim();
        diagnostics.push(format!("powershell-invocation:{invocation}"));
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_powershell_invocation_diagnostics(child, source, diagnostics);
    }
}

fn powershell_invocation_is_pure(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| child.kind() == "member_name")
        .and_then(|member| source.get(member.byte_range()))
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|member| PURE_POWERSHELL_METHODS.contains(&member.as_str()))
}

fn operation(source: &str, shell: PermissionShellKind) -> NormalizedOperation {
    let raw_argv = tokenize_words(source, &shell);
    let (environment_keys, argv) = match shell {
        PermissionShellKind::Bash => split_leading_bash_assignments(raw_argv),
        PermissionShellKind::Powershell
            if matches!(raw_argv.first().map(String::as_str), Some("&" | ".")) =>
        {
            (Vec::new(), raw_argv.into_iter().skip(1).collect())
        }
        PermissionShellKind::Powershell | PermissionShellKind::Cmd => (Vec::new(), raw_argv),
    };
    let executable = argv.first().cloned().unwrap_or_default();
    let dynamic = argv.is_empty()
        || executable.contains(['$', '(', ')', '`'])
        || has_dynamic_shell_wrapper_body(&argv);
    NormalizedOperation {
        shell,
        source: source.to_string(),
        executable,
        argv,
        environment_keys,
        dynamic,
        children: Vec::new(),
    }
}

fn tokenize_words(source: &str, shell: &PermissionShellKind) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let characters = source.trim().chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if escaped {
            current.push(character);
            escaped = false;
            index += 1;
            continue;
        }
        let is_escape = *shell == PermissionShellKind::Bash && character == '\\'
            || *shell == PermissionShellKind::Powershell && character == '`';
        if is_escape {
            escaped = true;
            index += 1;
            continue;
        }
        if matches!(character, '\'' | '"') && quote.is_none() {
            quote = Some(character);
            index += 1;
            continue;
        }
        if quote == Some(character) {
            if *shell == PermissionShellKind::Powershell
                && character == '\''
                && characters.get(index + 1) == Some(&'\'')
            {
                current.push('\'');
                index += 2;
                continue;
            }
            quote = None;
            index += 1;
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            index += 1;
            continue;
        }
        current.push(character);
        index += 1;
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn split_leading_bash_assignments(arguments: Vec<String>) -> (Vec<String>, Vec<String>) {
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
    let index = command_index.unwrap_or(arguments.len());
    let environment_keys = arguments[..index]
        .iter()
        .filter_map(|argument| argument.split_once('=').map(|(key, _)| key.to_string()))
        .collect();
    let argv = arguments.into_iter().skip(index).collect();
    (environment_keys, argv)
}

fn normalized_executable(raw: &str) -> String {
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
        .to_string()
}

fn paired_marker(value: &str, marker: char) -> bool {
    value
        .find(marker)
        .is_some_and(|start| value[start + marker.len_utf8()..].contains(marker))
}

fn has_dynamic_shell_wrapper_body(arguments: &[String]) -> bool {
    let executable = arguments
        .first()
        .map(|value| normalized_executable(value))
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

fn executable_from_prefix(prefix: &[char]) -> String {
    let prefix = prefix.iter().collect::<String>();
    tokenize_words(prefix.trim(), &PermissionShellKind::Powershell)
        .first()
        .map(|value| normalized_executable(value))
        .unwrap_or_default()
}

fn supports_powershell_argument_lists(executable: &str) -> bool {
    POWERSHELL_ARGUMENT_LIST_COMMANDS.contains(&executable)
        || executable
            .split_once('-')
            .is_some_and(|(verb, noun)| !verb.is_empty() && !noun.is_empty())
}

fn mask_powershell_parser_quirks(source: &str) -> String {
    let characters = source.chars().collect::<Vec<_>>();
    let mut output = characters.clone();
    let mut quote = None;
    let mut escaped = false;
    let mut statement_start = 0;
    let mut parent_statements = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if character == '`' && quote != Some('\'') {
            escaped = true;
            index += 1;
            continue;
        }
        if matches!(character, '\'' | '"') && quote.is_none() {
            quote = Some(character);
            index += 1;
            continue;
        }
        if quote == Some(character) {
            if character == '\'' && characters.get(index + 1) == Some(&'\'') {
                index += 2;
                continue;
            }
            quote = None;
            index += 1;
            continue;
        }
        if quote.is_some() {
            index += 1;
            continue;
        }
        if character == '(' {
            parent_statements.push(statement_start);
            statement_start = index + 1;
            index += 1;
            continue;
        }
        if character == ')' {
            statement_start = parent_statements.pop().unwrap_or(statement_start);
            index += 1;
            continue;
        }
        if matches!(character, '\r' | '\n' | ';' | '|' | '&' | '{' | '}') {
            statement_start = index + 1;
            index += 1;
            continue;
        }
        let executable = executable_from_prefix(&characters[statement_start..index]);
        if character == ',' && supports_powershell_argument_lists(&executable) {
            let previous = characters[..index]
                .iter()
                .rfind(|character| !character.is_whitespace())
                .copied()
                .unwrap_or_default();
            let next = characters[index + 1..]
                .iter()
                .find(|character| !character.is_whitespace())
                .copied()
                .unwrap_or_default();
            if previous != '\0'
                && next != '\0'
                && !";|&{}(),".contains(previous)
                && !";|&{}(),".contains(next)
            {
                output[index] = ' ';
                index += 1;
                continue;
            }
        }
        if character == '@'
            && POWERSHELL_SCOPED_PACKAGE_COMMANDS.contains(&executable.as_str())
            && index
                .checked_sub(1)
                .is_none_or(|previous| characters[previous].is_whitespace())
            && source_after_chars(&characters, index + 1)
                .split_once('/')
                .is_some_and(|(scope, _)| {
                    !scope.is_empty()
                        && scope.chars().all(|character| {
                            character.is_ascii_alphanumeric() || "_.-".contains(character)
                        })
                })
        {
            output[index] = 'z';
            index += 1;
            continue;
        }
        if character == '-'
            && POWERSHELL_NATIVE_COMMANDS.contains(&executable.as_str())
            && index
                .checked_sub(1)
                .is_none_or(|previous| characters[previous].is_whitespace())
        {
            let next = characters.get(index + 1).copied().unwrap_or_default();
            if next == '-' {
                let after = characters.get(index + 2).copied().unwrap_or_default();
                if after == '\0' || after.is_whitespace() || after.is_ascii_alphabetic() {
                    output[index] = 'z';
                    output[index + 1] = 'z';
                    index += 2;
                    continue;
                }
            } else if next == '\0' || next.is_whitespace() || next.is_ascii_alphabetic() {
                output[index] = 'z';
            }
        }
        index += 1;
    }
    output.into_iter().collect()
}

fn source_after_chars(characters: &[char], start: usize) -> String {
    characters[start..].iter().collect()
}

fn mask_bash_windows_paths(source: &str) -> String {
    let characters = source.chars().collect::<Vec<_>>();
    let mut output = characters.clone();
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in characters.iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
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
        if quote.is_some() || character != ':' {
            continue;
        }
        let drive = index
            .checked_sub(1)
            .and_then(|previous| characters.get(previous))
            .copied()
            .unwrap_or_default();
        let boundary = index
            .checked_sub(2)
            .and_then(|previous| characters.get(previous))
            .copied()
            .unwrap_or_default();
        if drive.is_ascii_alphabetic()
            && characters.get(index + 1) == Some(&'/')
            && (boundary == '\0' || boundary.is_whitespace() || boundary == '=')
        {
            output[index] = '_';
        }
    }
    output.into_iter().collect()
}

fn scan_syntax(
    source: &str,
    shell: &PermissionShellKind,
) -> (Vec<String>, Vec<NormalizedRedirect>) {
    let characters = source.chars().collect::<Vec<_>>();
    let mut operators = Vec::new();
    let mut redirects = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        let escape = *shell == PermissionShellKind::Bash && character == '\\'
            || *shell == PermissionShellKind::Powershell && character == '`';
        if escape {
            escaped = true;
            index += 1;
            continue;
        }
        if matches!(character, '\'' | '"') && quote.is_none() {
            quote = Some(character);
            index += 1;
            continue;
        }
        if quote == Some(character) {
            quote = None;
            index += 1;
            continue;
        }
        if quote.is_some() {
            index += 1;
            continue;
        }
        let next = characters.get(index + 1).copied().unwrap_or_default();
        if matches!((character, next), ('&', '&') | ('|', '|')) {
            operators.push(format!("{character}{next}"));
            index += 2;
            continue;
        }
        if character == '>' {
            let append = next == '>';
            let target_start = index + usize::from(append) + 1;
            redirects.push(NormalizedRedirect {
                operator: if append { ">>" } else { ">" }.to_string(),
                target: redirect_target(&characters[target_start..], shell),
            });
            index += usize::from(append) + 1;
            continue;
        }
        if character == '<' {
            redirects.push(NormalizedRedirect {
                operator: "<".to_string(),
                target: redirect_target(&characters[index + 1..], shell),
            });
        } else if matches!(character, '|' | ';') {
            operators.push(character.to_string());
        }
        index += 1;
    }
    (operators, redirects)
}

fn redirect_target(characters: &[char], shell: &PermissionShellKind) -> String {
    let remainder = characters.iter().collect::<String>();
    tokenize_words(&remainder, shell)
        .first()
        .cloned()
        .unwrap_or_default()
}

pub struct CmdCommandParser;

impl CmdCommandParser {
    #[must_use]
    pub fn parse(command: &str) -> NormalizedOperationGraph {
        let executable_command = collapse_cmd_line_continuations(command);
        let mut segments = Vec::new();
        let mut operators = Vec::new();
        let mut redirects = Vec::new();
        let mut current = String::new();
        let mut quoted = false;
        let mut escaped = false;
        let characters = executable_command.chars().collect::<Vec<_>>();
        let mut index = 0;
        while index < characters.len() {
            let character = characters[index];
            if escaped {
                current.push(character);
                escaped = false;
                index += 1;
                continue;
            }
            if character == '^' {
                current.push(character);
                escaped = true;
                index += 1;
                continue;
            }
            if character == '"' {
                quoted = !quoted;
                current.push(character);
                index += 1;
                continue;
            }
            if !quoted {
                if matches!(character, '\r' | '\n') {
                    push_segment(&mut segments, &mut current);
                    operators.push("\n".to_string());
                    if character == '\r' && characters.get(index + 1) == Some(&'\n') {
                        index += 1;
                    }
                    index += 1;
                    continue;
                }
                let next = characters.get(index + 1).copied().unwrap_or_default();
                if matches!((character, next), ('&', '&') | ('|', '|')) {
                    push_segment(&mut segments, &mut current);
                    operators.push(format!("{character}{next}"));
                    index += 2;
                    continue;
                }
                if character == '>' {
                    let append = next == '>';
                    let target_start = index + usize::from(append) + 1;
                    redirects.push(NormalizedRedirect {
                        operator: if append { ">>" } else { ">" }.to_string(),
                        target: redirect_target(
                            &characters[target_start..],
                            &PermissionShellKind::Cmd,
                        ),
                    });
                } else if character == '<' {
                    redirects.push(NormalizedRedirect {
                        operator: "<".to_string(),
                        target: redirect_target(
                            &characters[index + 1..],
                            &PermissionShellKind::Cmd,
                        ),
                    });
                } else if matches!(character, '&' | '|') {
                    push_segment(&mut segments, &mut current);
                    operators.push(character.to_string());
                    index += 1;
                    continue;
                }
            }
            current.push(character);
            index += 1;
        }
        push_segment(&mut segments, &mut current);
        let operations = segments
            .into_iter()
            .map(|source| operation(&source, PermissionShellKind::Cmd))
            .collect();
        NormalizedOperationGraph {
            shell: PermissionShellKind::Cmd,
            source: command.to_string(),
            operations,
            operators,
            redirects,
            diagnostics: Vec::new(),
        }
    }
}

fn push_segment(segments: &mut Vec<String>, current: &mut String) {
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    current.clear();
}

fn collapse_cmd_line_continuations(command: &str) -> String {
    let Ok(pattern) = regex::Regex::new(r"(\^+)(\r\n|\r|\n)") else {
        return command.to_string();
    };
    pattern
        .replace_all(command, |captures: &regex::Captures<'_>| {
            let carets = &captures[1];
            let newline = &captures[2];
            if carets.len() % 2 == 1 {
                carets[..carets.len() - 1].to_string()
            } else {
                format!("{carets}{newline}")
            }
        })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::ShellCommandParser;
    use crate::permission::shell::types::PermissionShellKind;

    #[test]
    fn powershell_parser_accepts_cargo_option_terminators() {
        let graph = ShellCommandParser::parse(
            PermissionShellKind::Powershell,
            "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings",
        );

        assert!(
            graph.diagnostics.is_empty()
                && graph.operations.len() == 1
                && graph.operations[0]
                    .argv
                    .first()
                    .is_some_and(|value| value == "cargo")
        );
    }

    #[test]
    fn powershell_parser_accepts_cargo_chains_with_failure_guards() {
        let graph = ShellCommandParser::parse(
            PermissionShellKind::Powershell,
            "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check; if (-not $?) { exit 1 }; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings; if (-not $?) { exit 1 }; cargo test --manifest-path src-tauri/Cargo.toml",
        );
        let cargo_operations = graph
            .operations
            .iter()
            .filter(|operation| operation.executable.eq_ignore_ascii_case("cargo"))
            .count();

        assert!(graph.diagnostics.is_empty() && cargo_operations == 3);
    }

    #[test]
    fn powershell_parser_extracts_commands_from_read_only_control_flow() {
        let command = r#"$patterns = @('README*','.github/**/*','scripts/**/*','docs/testing/**/*','src/**/*.css','src/**/*.scss'); foreach ($pattern in $patterns) { "===== $pattern ====="; $matches = @(Get-ChildItem -Path $pattern -File -Recurse -ErrorAction SilentlyContinue); if ($matches.Count -eq 0) { '(none)' } else { $matches | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1) } } }; "===== root ====="; Get-ChildItem -Force | Select-Object Mode,Name | Format-Table -AutoSize"#;
        let graph = ShellCommandParser::parse(PermissionShellKind::Powershell, command);
        let executables = graph
            .operations
            .iter()
            .map(|operation| operation.executable.to_ascii_lowercase())
            .collect::<Vec<_>>();

        assert!(
            graph.diagnostics.is_empty()
                && executables
                    .iter()
                    .filter(|value| *value == "get-childitem")
                    .count()
                    == 2
                && executables.contains(&"foreach-object".to_string())
                && executables.contains(&"get-location".to_string())
                && executables.contains(&"select-object".to_string())
                && executables.contains(&"format-table".to_string())
        );
    }

    #[test]
    fn powershell_parser_marks_dynamic_command_names() {
        let graph = ShellCommandParser::parse(PermissionShellKind::Powershell, "& $command arg");

        assert!(graph.operations.iter().any(|operation| operation.dynamic));
    }

    #[test]
    fn powershell_parser_rejects_non_pure_dotnet_invocations() {
        let graph = ShellCommandParser::parse(
            PermissionShellKind::Powershell,
            "[System.IO.File]::Delete('important.txt')",
        );

        assert!(
            graph
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.starts_with("powershell-invocation:"))
        );
    }
}
