use crate::permission::shell::types::{
    NormalizedOperation, NormalizedOperationGraph, NormalizedRedirect, PermissionShellKind,
};

fn tokenize(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;

    for char in command.trim().chars() {
        if escaped {
            current.push(char);
            escaped = false;
            continue;
        }
        if char == '^' {
            escaped = true;
            continue;
        }
        if char == '"' {
            quoted = !quoted;
            continue;
        }
        if char.is_whitespace() && !quoted {
            if !current.is_empty() {
                tokens.push(current.clone());
                current.clear();
            }
            continue;
        }
        current.push(char);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn collapse_line_continuations(command: &str) -> String {
    let Ok(re) = regex::Regex::new(r"(\^+)(\r\n|\r|\n)") else {
        return command.to_string();
    };
    re.replace_all(command, |caps: &regex::Captures| {
        let carets = &caps[1];
        let newline = &caps[2];
        if carets.len() % 2 == 1 {
            carets[..carets.len() - 1].to_string()
        } else {
            format!("{}{}", carets, newline)
        }
    })
    .to_string()
}

pub struct CmdCommandParser;

impl CmdCommandParser {
    pub fn parse(command: &str) -> NormalizedOperationGraph {
        let executable_command = collapse_line_continuations(command);
        let mut segments = Vec::new();
        let mut operators = Vec::new();
        let mut redirects = Vec::new();
        let mut current = String::new();
        let mut quoted = false;
        let mut escaped = false;

        let chars: Vec<char> = executable_command.chars().collect();
        let mut index = 0;

        while index < chars.len() {
            let char = chars[index];
            if escaped {
                current.push(char);
                escaped = false;
                index += 1;
                continue;
            }
            if char == '^' {
                current.push(char);
                escaped = true;
                index += 1;
                continue;
            }
            if char == '"' {
                quoted = !quoted;
                current.push(char);
                index += 1;
                continue;
            }
            if !quoted {
                if char == '\r' || char == '\n' {
                    if !current.trim().is_empty() {
                        segments.push(current.trim().to_string());
                    }
                    current.clear();
                    operators.push("\n".to_string());
                    if char == '\r' && index + 1 < chars.len() && chars[index + 1] == '\n' {
                        index += 1;
                    }
                    index += 1;
                    continue;
                }

                let pair = if index + 1 < chars.len() {
                    let mut s = String::new();
                    s.push(char);
                    s.push(chars[index + 1]);
                    s
                } else {
                    String::new()
                };

                if pair == "&&" || pair == "||" || pair == ">>" {
                    if pair == ">>" {
                        let target_str: String = chars[index + 2..].iter().collect();
                        let target = target_str
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .to_string();
                        redirects.push(NormalizedRedirect {
                            operator: ">>".to_string(),
                            target,
                        });
                        current.push_str(&pair);
                    } else {
                        if !current.trim().is_empty() {
                            segments.push(current.trim().to_string());
                        }
                        current.clear();
                        operators.push(pair.clone());
                    }
                    index += 2;
                    continue;
                }

                if char == '&' || char == '|' {
                    if !current.trim().is_empty() {
                        segments.push(current.trim().to_string());
                    }
                    current.clear();
                    operators.push(char.to_string());
                    index += 1;
                    continue;
                }

                if char == '>' || char == '<' {
                    let target_str: String = chars[index + 1..].iter().collect();
                    let target = target_str
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    redirects.push(NormalizedRedirect {
                        operator: char.to_string(),
                        target,
                    });
                }
            }
            current.push(char);
            index += 1;
        }

        if !current.trim().is_empty() {
            segments.push(current.trim().to_string());
        }

        let operations: Vec<NormalizedOperation> = segments
            .into_iter()
            .map(|source| {
                let argv = tokenize(&source);
                let executable = argv.first().cloned().unwrap_or_default();
                let dynamic =
                    argv.is_empty() || executable.contains('%') || executable.contains('!');
                NormalizedOperation {
                    shell: PermissionShellKind::Cmd,
                    source,
                    executable,
                    argv,
                    dynamic,
                    children: Vec::new(),
                }
            })
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
