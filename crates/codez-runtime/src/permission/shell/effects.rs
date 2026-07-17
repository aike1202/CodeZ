use std::collections::BTreeSet;

use super::policies::normalize_executable_name;
use super::types::{NormalizedOperation, PermissionShellKind};

const SAFE_ENVIRONMENT_KEYS: &[&str] = &[
    "CARGO_TERM_COLOR",
    "CARGO_TERM_PROGRESS_WHEN",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "COLORTERM",
    "FORCE_COLOR",
    "NO_COLOR",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "RUST_LOG_STYLE",
    "RUST_MIN_STACK",
    "RUST_TEST_THREADS",
];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GenericCommandEffects {
    pub incomplete_reasons: Vec<String>,
    pub unsafe_environment_keys: Vec<String>,
    pub read_paths: Vec<String>,
    pub write_paths: Vec<String>,
}

#[must_use]
pub fn analyze_operation(operation: &NormalizedOperation) -> GenericCommandEffects {
    let mut environment_keys = operation
        .environment_keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    collect_env_wrapper_keys(&operation.argv, &mut environment_keys);
    let unsafe_environment_keys = environment_keys
        .into_iter()
        .filter(|key| !SAFE_ENVIRONMENT_KEYS.contains(&key.as_str()))
        .collect();
    let (read_paths, incomplete_reasons) = command_read_path_effects(operation);
    GenericCommandEffects {
        incomplete_reasons,
        unsafe_environment_keys,
        read_paths,
        write_paths: command_write_paths(&operation.argv),
    }
}

#[must_use]
pub fn unwrap_process_wrappers(arguments: &[String]) -> &[String] {
    let mut current = arguments;
    for _ in 0..8 {
        let Some(inner) = strip_process_wrapper(current) else {
            break;
        };
        current = inner;
    }
    current
}

fn strip_process_wrapper(arguments: &[String]) -> Option<&[String]> {
    let executable = normalize_executable_name(arguments.first()?);
    let mut index = 1;
    match executable.as_str() {
        "env" => {
            while let Some(argument) = arguments.get(index) {
                if argument == "--" {
                    index += 1;
                    break;
                }
                if argument.starts_with('-') || is_environment_assignment(argument) {
                    index += 1;
                    continue;
                }
                break;
            }
        }
        "timeout" => {
            while arguments
                .get(index)
                .is_some_and(|argument| argument.starts_with('-'))
            {
                let consumes_value = matches!(
                    arguments[index].as_str(),
                    "-k" | "-s" | "--kill-after" | "--signal"
                );
                index += 1 + usize::from(consumes_value);
            }
            arguments.get(index)?;
            index += 1;
        }
        "nice" | "ionice" | "chrt" | "stdbuf" => {
            while arguments
                .get(index)
                .is_some_and(|argument| argument.starts_with('-'))
            {
                let consumes_value = matches!(
                    arguments[index].as_str(),
                    "-c" | "-e" | "-i" | "-n" | "-o" | "-p" | "-P" | "-u"
                );
                index += 1 + usize::from(consumes_value);
            }
            if executable == "chrt" {
                arguments.get(index)?;
                index += 1;
            }
        }
        _ => return None,
    }
    arguments.get(index..).filter(|inner| !inner.is_empty())
}

fn collect_env_wrapper_keys(arguments: &[String], keys: &mut BTreeSet<String>) {
    let mut current = arguments;
    for _ in 0..8 {
        if normalize_executable_name(current.first().map_or("", String::as_str)) == "env" {
            for argument in &current[1..] {
                if argument == "--" {
                    continue;
                }
                if argument.starts_with('-') {
                    keys.insert("<env-option>".to_string());
                    continue;
                }
                let Some((key, _)) = argument.split_once('=') else {
                    break;
                };
                keys.insert(key.to_string());
            }
        }
        let Some(inner) = strip_process_wrapper(current) else {
            break;
        };
        current = inner;
    }
}

fn is_environment_assignment(argument: &str) -> bool {
    let Some((key, _)) = argument.split_once('=') else {
        return false;
    };
    let mut characters = key.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn option_value(arguments: &[String], names: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    for (index, argument) in arguments.iter().enumerate() {
        if names.contains(&argument.as_str()) {
            if let Some(value) = arguments.get(index + 1) {
                values.push(value.clone());
            }
            continue;
        }
        for name in names.iter().filter(|name| name.starts_with("--")) {
            if let Some(value) = argument.strip_prefix(&format!("{name}=")) {
                values.push(value.to_string());
            }
        }
    }
    values
}

fn positional_arguments(arguments: &[String]) -> impl Iterator<Item = &String> {
    arguments
        .iter()
        .skip(1)
        .filter(|argument| !argument.starts_with('-'))
}

fn literal_path_anchor(argument: &str) -> Option<String> {
    if argument.contains(['$', '%']) {
        return None;
    }
    let wildcard = argument.find(['*', '?', '[']);
    let anchor = wildcard.map_or(argument, |index| {
        let prefix = &argument[..index];
        prefix
            .rfind(['/', '\\'])
            .map_or("", |separator| &prefix[..separator])
    });
    (!anchor.is_empty()).then(|| anchor.to_string())
}

fn powershell_literal_paths(argument: &str) -> impl Iterator<Item = String> + '_ {
    argument.split(',').filter_map(|path| {
        let path = path.trim();
        (!path.is_empty())
            .then(|| literal_path_anchor(path))
            .flatten()
    })
}

fn powershell_parameter_name(argument: &str) -> (&str, Option<&str>) {
    argument
        .split_once(':')
        .map_or((argument, None), |(name, value)| (name, Some(value)))
}

fn powershell_parameter_is_switch(executable: &str, parameter: &str) -> bool {
    matches!(
        parameter,
        "-confirm" | "-debug" | "-db" | "-verbose" | "-vb" | "-whatif"
    ) || matches!(executable, "dir" | "gci" | "get-childitem" | "ls")
        && matches!(
            parameter,
            "-codesigningcert"
                | "-directory"
                | "-file"
                | "-follow-symlink"
                | "-force"
                | "-hidden"
                | "-name"
                | "-readonly"
                | "-recurse"
                | "-system"
        )
        || matches!(executable, "cat" | "gc" | "get-content" | "type")
            && matches!(parameter, "-asbytestream" | "-raw" | "-wait")
}

fn powershell_parameter_consumes_value(executable: &str, parameter: &str) -> bool {
    matches!(
        parameter,
        "-debugvariable"
            | "-erroraction"
            | "-errorvariable"
            | "-ea"
            | "-ev"
            | "-informationaction"
            | "-informationvariable"
            | "-infa"
            | "-iv"
            | "-outbuffer"
            | "-outvariable"
            | "-ob"
            | "-ov"
            | "-pipelinevariable"
            | "-progressaction"
            | "-pv"
            | "-warningaction"
            | "-warningvariable"
            | "-wa"
            | "-wv"
    ) || matches!(executable, "dir" | "gci" | "get-childitem" | "ls")
        && matches!(
            parameter,
            "-attributes" | "-credential" | "-depth" | "-exclude" | "-filter" | "-include"
        )
        || matches!(executable, "cat" | "gc" | "get-content" | "type")
            && matches!(
                parameter,
                "-credential"
                    | "-delimiter"
                    | "-encoding"
                    | "-exclude"
                    | "-filter"
                    | "-include"
                    | "-readcount"
                    | "-stream"
                    | "-tail"
                    | "-totalcount"
            )
}

fn powershell_command_read_path_effects(arguments: &[String]) -> (Vec<String>, Vec<String>) {
    let executable = normalize_executable_name(arguments.first().map_or("", String::as_str));
    if !matches!(
        executable.as_str(),
        "cat" | "dir" | "gc" | "gci" | "get-childitem" | "get-content" | "ls" | "type"
    ) {
        return (Vec::new(), Vec::new());
    }

    let mut paths = BTreeSet::new();
    let mut incomplete_reasons = BTreeSet::new();
    let mut index = 1;
    while let Some(argument) = arguments.get(index) {
        if argument.starts_with('-') {
            let (parameter, inline_value) = powershell_parameter_name(argument);
            let parameter = parameter.to_ascii_lowercase();
            if matches!(parameter.as_str(), "-path" | "-literalpath") {
                let value = inline_value.or_else(|| arguments.get(index + 1).map(String::as_str));
                if inline_value.is_none() && value.is_some() {
                    index += 1;
                }
                if let Some(value) = value {
                    paths.extend(powershell_literal_paths(value));
                }
            } else if !powershell_parameter_is_switch(&executable, &parameter) {
                if powershell_parameter_consumes_value(&executable, &parameter) {
                    if inline_value.is_none() && arguments.get(index + 1).is_some() {
                        index += 1;
                    }
                } else {
                    incomplete_reasons.insert(format!(
                        "The PowerShell parameter `{parameter}` does not have known path semantics."
                    ));
                }
            }
        } else {
            paths.extend(powershell_literal_paths(argument));
        }
        index += 1;
    }
    (
        paths.into_iter().collect(),
        incomplete_reasons.into_iter().collect(),
    )
}

#[must_use]
pub fn command_read_paths(operation: &NormalizedOperation) -> Vec<String> {
    command_read_path_effects(operation).0
}

fn command_read_path_effects(operation: &NormalizedOperation) -> (Vec<String>, Vec<String>) {
    let arguments = unwrap_process_wrappers(&operation.argv);
    if operation.shell == PermissionShellKind::Powershell {
        return powershell_command_read_path_effects(arguments);
    }
    let executable = normalize_executable_name(arguments.first().map_or("", String::as_str));
    let reads_positional = matches!(
        executable.as_str(),
        "cat"
            | "diff"
            | "dir"
            | "gc"
            | "gci"
            | "get-childitem"
            | "get-content"
            | "head"
            | "ls"
            | "sort"
            | "tail"
            | "type"
            | "uniq"
            | "wc"
    );
    if !reads_positional {
        return (Vec::new(), Vec::new());
    }
    (
        positional_arguments(arguments)
            .filter_map(|argument| literal_path_anchor(argument))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        Vec::new(),
    )
}

#[must_use]
pub fn command_write_paths(arguments: &[String]) -> Vec<String> {
    let arguments = unwrap_process_wrappers(arguments);
    let executable = normalize_executable_name(arguments.first().map_or("", String::as_str));
    let mut paths = BTreeSet::new();
    match executable.as_str() {
        "dd" => {
            paths.extend(
                arguments
                    .iter()
                    .skip(1)
                    .filter_map(|argument| argument.strip_prefix("of="))
                    .map(str::to_string),
            );
        }
        "git" => paths.extend(option_value(arguments, &["-o", "-O", "--output"])),
        "go" | "rustc" | "sort" | "tree" => {
            paths.extend(option_value(arguments, &["-o", "--output"]));
        }
        "tee" | "tee-object" | "truncate" => {
            paths.extend(positional_arguments(arguments).cloned());
        }
        "uniq" => {
            if let Some(output) = positional_arguments(arguments).nth(1) {
                paths.insert(output.clone());
            }
        }
        "cp" | "install" | "ln" | "move-item" | "mv" => {
            if let Some(destination) = positional_arguments(arguments).last() {
                paths.insert(destination.clone());
            }
        }
        "sed"
            if arguments.iter().any(|argument| {
                argument == "-i" || argument.starts_with("-i") || argument.starts_with("--in-place")
            }) =>
        {
            paths.extend(positional_arguments(arguments).cloned())
        }
        _ => {}
    }
    paths.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_operation, command_read_paths, command_write_paths, unwrap_process_wrappers,
    };
    use crate::permission::shell::parser::ShellCommandParser;
    use crate::permission::shell::types::PermissionShellKind;

    fn operation(command: &str) -> crate::permission::shell::types::NormalizedOperation {
        ShellCommandParser::parse(PermissionShellKind::Bash, command)
            .operations
            .into_iter()
            .next()
            .expect("fixture must contain one operation")
    }

    fn powershell_operation(command: &str) -> crate::permission::shell::types::NormalizedOperation {
        ShellCommandParser::parse(PermissionShellKind::Powershell, command)
            .operations
            .into_iter()
            .next()
            .expect("fixture must contain one operation")
    }

    #[test]
    fn unsafe_inline_environment_is_preserved_for_policy_analysis() {
        let effects = analyze_operation(&operation("LD_PRELOAD=/tmp/inject.so ls"));
        assert_eq!(effects.unsafe_environment_keys, ["LD_PRELOAD"]);
    }

    #[test]
    fn cosmetic_environment_is_allowed() {
        let effects = analyze_operation(&operation("RUST_LOG=debug cargo test"));
        assert!(effects.unsafe_environment_keys.is_empty());
    }

    #[test]
    fn nested_env_wrapper_is_analyzed_and_unwrapped() {
        let operation = operation("timeout 30 env PATH=/tmp cargo test");
        let effects = analyze_operation(&operation);
        assert_eq!(effects.unsafe_environment_keys, ["PATH"]);
        assert_eq!(unwrap_process_wrappers(&operation.argv)[0], "cargo");
    }

    #[test]
    fn command_internal_output_paths_are_extracted() {
        assert_eq!(
            command_write_paths(&["sort".into(), "-o".into(), "out.txt".into()]),
            ["out.txt"]
        );
        assert_eq!(
            command_write_paths(&["git".into(), "diff".into(), "--output=diff.txt".into()]),
            ["diff.txt"]
        );
    }

    #[test]
    fn literal_read_paths_are_extracted_without_treating_globs_as_paths() {
        assert_eq!(
            command_read_paths(&operation("cat /outside/file.txt")),
            ["/outside/file.txt"]
        );
        assert!(command_read_paths(&operation("ls *.rs")).is_empty());
    }

    #[test]
    fn powershell_path_arrays_are_split_into_individual_read_targets() {
        assert_eq!(
            command_read_paths(&powershell_operation(
                "Get-ChildItem -Recurse src,src-tauri/src,src-tauri/tests -File"
            )),
            ["src", "src-tauri/src", "src-tauri/tests"]
        );
    }

    #[test]
    fn powershell_common_parameter_values_are_not_read_targets() {
        assert!(
            command_read_paths(&powershell_operation(
                "Get-ChildItem -Path $pattern -File -Recurse -ErrorAction SilentlyContinue"
            ))
            .is_empty()
        );
    }

    #[test]
    fn unknown_powershell_parameters_make_path_analysis_incomplete() {
        let effects = analyze_operation(&powershell_operation(
            "Get-ChildItem -UnknownParameter C:\\outside",
        ));
        assert!(!effects.incomplete_reasons.is_empty());
    }

    #[test]
    fn globbed_read_targets_preserve_their_literal_directory_anchor() {
        assert_eq!(
            command_read_paths(&operation("cat ../outside/*.txt")),
            ["../outside"]
        );
    }
}
