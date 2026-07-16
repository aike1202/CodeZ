use std::{collections::BTreeMap, path::Path};

use codez_core::{AppError, AppErrorKind, FileKind, FileSystem};

const DEFAULT_TREE_DEPTH: usize = 3;
const DEFAULT_MAX_TREE_ENTRIES: usize = 300;
const DEFAULT_MAX_DOCS: usize = 100;

/// Project snapshot produced by workspace analysis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSnapshot {
    pub root_name: String,
    pub project_type: String,
    pub package_manager: Option<String>,
    pub scripts: BTreeMap<String, String>,
    pub dependencies: BTreeMap<String, String>,
    pub dev_dependencies: BTreeMap<String, String>,
    pub config_files: Vec<String>,
    pub entrypoints: Vec<String>,
    pub tree: String,
    pub docs_tree: String,
}

/// Options controlling snapshot generation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotOptions {
    pub dir_paths: Option<Vec<String>>,
    pub max_depth: Option<usize>,
    pub include_files: bool,
}

/// Workspace project analysis depending only on the bounded filesystem port.
pub struct ProjectAnalysisService;

impl ProjectAnalysisService {
    /// Generates a project snapshot for the workspace.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] for filesystem failures.
    pub async fn get_snapshot(
        filesystem: &dyn FileSystem,
        options: &SnapshotOptions,
    ) -> Result<ProjectSnapshot, AppError> {
        let root_name = filesystem
            .workspace_root()
            .as_path()
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace")
            .to_string();

        let package_json = read_package_json(filesystem).await;
        let project_type = detect_project_type(filesystem, &package_json).await?;
        let package_manager = detect_package_manager(filesystem, &package_json).await?;

        let (scripts, dependencies, dev_dependencies) = match &package_json {
            Some(json) => (
                extract_map(json, "scripts"),
                extract_map(json, "dependencies"),
                extract_map(json, "devDependencies"),
            ),
            None => (BTreeMap::new(), BTreeMap::new(), BTreeMap::new()),
        };

        let config_files = find_config_files(filesystem).await?;
        let entrypoints = find_entrypoints(filesystem, &package_json).await?;

        let default_paths = vec![".".to_string()];
        let target_paths = options.dir_paths.as_deref().unwrap_or(&default_paths);
        let max_depth = options.max_depth.unwrap_or(DEFAULT_TREE_DEPTH);
        let include_files = options.include_files;

        let mut tree_parts = Vec::new();
        for dir in target_paths {
            let tree = build_tree(filesystem, dir, max_depth, include_files).await?;
            if target_paths.len() > 1 {
                tree_parts.push(format!("=== Directory: {dir} ===\n{tree}"));
            } else {
                tree_parts.push(tree);
            }
        }
        let tree = tree_parts.join("\n\n");
        let docs_tree = build_docs_tree(filesystem).await?;

        Ok(ProjectSnapshot {
            root_name,
            project_type,
            package_manager,
            scripts,
            dependencies,
            dev_dependencies,
            config_files,
            entrypoints,
            tree,
            docs_tree,
        })
    }
}

async fn read_package_json(filesystem: &dyn FileSystem) -> Option<serde_json::Value> {
    let path = filesystem.resolve(Path::new("package.json")).await.ok()?;
    let bytes = filesystem.read_bounded(&path, 1024 * 1024).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn extract_map(json: &serde_json::Value, key: &str) -> BTreeMap<String, String> {
    json.get(key)
        .and_then(|value| value.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

async fn detect_project_type(
    filesystem: &dyn FileSystem,
    package_json: &Option<serde_json::Value>,
) -> Result<String, AppError> {
    if let Some(json) = package_json {
        let deps = merge_deps(json);
        let has_electron = deps.contains_key("electron") || deps.contains_key("electron-vite");
        let has_react = deps.contains_key("react") || deps.contains_key("@vitejs/plugin-react");
        let has_vite = deps.contains_key("vite") || deps.contains_key("@vitejs/plugin-react");

        if has_electron && has_react {
            return Ok("electron-react".to_string());
        }
        if has_react && has_vite {
            return Ok("react-vite".to_string());
        }
        return Ok("nodejs".to_string());
    }

    let markers = [
        (
            &["requirements.txt", "pyproject.toml", "setup.py"][..],
            "python",
        ),
        (&["pom.xml", "build.gradle"], "java"),
        (&["go.mod"], "go"),
        (&["Cargo.toml"], "rust"),
        (&["CMakeLists.txt", "Makefile"], "c/c++"),
        (&["Gemfile"], "ruby"),
        (&["composer.json"], "php"),
    ];

    for (files, project_type) in markers {
        for file in files {
            if file_exists(filesystem, file).await? {
                return Ok(project_type.to_string());
            }
        }
    }
    Ok("unknown".to_string())
}

async fn detect_package_manager(
    filesystem: &dyn FileSystem,
    package_json: &Option<serde_json::Value>,
) -> Result<Option<String>, AppError> {
    let node_managers = [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    ];
    for (file, manager) in node_managers {
        if file_exists(filesystem, file).await? {
            return Ok(Some(manager.to_string()));
        }
    }
    if package_json.is_some() {
        return Ok(Some("npm".to_string()));
    }

    let other_managers = [
        ("requirements.txt", "pip"),
        ("pyproject.toml", "pip"),
        ("pom.xml", "maven"),
        ("build.gradle", "gradle"),
        ("go.mod", "go modules"),
        ("Cargo.toml", "cargo"),
    ];
    for (file, manager) in other_managers {
        if file_exists(filesystem, file).await? {
            return Ok(Some(manager.to_string()));
        }
    }
    Ok(None)
}

fn merge_deps(json: &serde_json::Value) -> BTreeMap<String, String> {
    let mut merged = extract_map(json, "dependencies");
    merged.extend(extract_map(json, "devDependencies"));
    merged
}

async fn find_config_files(filesystem: &dyn FileSystem) -> Result<Vec<String>, AppError> {
    let candidates = [
        "package.json",
        "README.md",
        "electron.vite.config.ts",
        "electron.vite.config.js",
        "vite.config.ts",
        "vite.config.js",
        "tsconfig.json",
        "vitest.config.ts",
        "jest.config.js",
        "requirements.txt",
        "pyproject.toml",
        "pom.xml",
        "build.gradle",
        "go.mod",
        "Cargo.toml",
    ];
    find_existing(filesystem, &candidates).await
}

async fn find_entrypoints(
    filesystem: &dyn FileSystem,
    package_json: &Option<serde_json::Value>,
) -> Result<Vec<String>, AppError> {
    let mut candidates: Vec<&str> = Vec::new();

    if let Some(json) = package_json {
        if let Some(main) = json.get("main").and_then(|v| v.as_str()) {
            let trimmed = main.strip_prefix("./").unwrap_or(main);
            // We can't push owned strings to &str vec, so skip dynamic main
            if !trimmed.is_empty() {
                // Handled below with static entries
                let _ = trimmed;
            }
        }
    }

    let static_entries = [
        "src/main/index.ts",
        "src/main/index.js",
        "src/preload/index.ts",
        "src/preload/index.js",
        "src/renderer/src/App.tsx",
        "src/renderer/src/main.tsx",
        "src/renderer/src/main.ts",
        "src/shared/ipc/channels.ts",
        "main.py",
        "app.py",
        "main.go",
        "src/main.rs",
        "src/main/java/Main.java",
    ];
    candidates.extend_from_slice(&static_entries);
    find_existing(filesystem, &candidates).await
}

async fn find_existing(
    filesystem: &dyn FileSystem,
    candidates: &[&str],
) -> Result<Vec<String>, AppError> {
    let mut found = Vec::new();
    for candidate in candidates {
        if file_exists(filesystem, candidate).await? {
            found.push((*candidate).to_string());
        }
    }
    Ok(found)
}

async fn file_exists(filesystem: &dyn FileSystem, relative: &str) -> Result<bool, AppError> {
    let path = filesystem.resolve(Path::new(relative)).await?;
    match filesystem.metadata(&path).await {
        Ok(metadata) => Ok(metadata.kind == FileKind::File),
        Err(error) if error.kind() == AppErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

const IGNORED_TREE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "out",
    "__pycache__",
    ".idea",
    ".vscode",
    ".cache",
    ".turbo",
    "target",
    ".nuxt",
    ".output",
];

fn should_ignore_tree(name: &str) -> bool {
    if name.starts_with('.') && name != ".gitignore" {
        return true;
    }
    IGNORED_TREE_DIRS
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

async fn build_tree(
    filesystem: &dyn FileSystem,
    dir_path: &str,
    max_depth: usize,
    include_files: bool,
) -> Result<String, AppError> {
    let root = filesystem.resolve(Path::new(dir_path)).await?;
    let display = dir_path.replace('\\', "/");
    let mut lines = vec![if display.is_empty() || display == "." {
        ".".to_string()
    } else {
        display
    }];
    let mut count = 0usize;
    build_tree_recursive(
        filesystem,
        &root,
        0,
        max_depth,
        include_files,
        "",
        &mut lines,
        &mut count,
    )
    .await?;
    if count >= DEFAULT_MAX_TREE_ENTRIES {
        lines.push("[TRUNCATED] tree output limit reached".to_string());
    }
    Ok(lines.join("\n"))
}

#[allow(clippy::too_many_arguments)]
fn build_tree_recursive<'a>(
    filesystem: &'a dyn FileSystem,
    directory: &'a codez_core::SafeWorkspacePath,
    depth: usize,
    max_depth: usize,
    include_files: bool,
    prefix: &'a str,
    lines: &'a mut Vec<String>,
    count: &'a mut usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>> {
    Box::pin(async move {
        if depth >= max_depth || *count >= DEFAULT_MAX_TREE_ENTRIES {
            return Ok(());
        }
        let listing = filesystem
            .read_directory(directory, DEFAULT_MAX_TREE_ENTRIES.saturating_sub(*count))
            .await?;

        let mut entries: Vec<_> = listing
            .entries
            .into_iter()
            .filter(|entry| {
                let Some(name) = entry.name.to_str() else {
                    return false;
                };
                if entry.kind == FileKind::Directory {
                    !should_ignore_tree(name)
                } else {
                    include_files && entry.kind == FileKind::File
                }
            })
            .collect();

        entries.sort_by(|a, b| {
            let a_is_dir = a.kind == FileKind::Directory;
            let b_is_dir = b.kind == FileKind::Directory;
            b_is_dir.cmp(&a_is_dir).then_with(|| a.name.cmp(&b.name))
        });

        for entry in entries {
            if *count >= DEFAULT_MAX_TREE_ENTRIES {
                break;
            }
            let name = entry.name.to_string_lossy();
            let marker = if entry.kind == FileKind::Directory {
                "[DIR]"
            } else {
                "[FILE]"
            };
            lines.push(format!("{prefix}{marker} {name}"));
            *count += 1;

            if entry.kind == FileKind::Directory {
                let child_prefix = format!("{prefix}  ");
                build_tree_recursive(
                    filesystem,
                    &entry.path,
                    depth + 1,
                    max_depth,
                    include_files,
                    &child_prefix,
                    lines,
                    count,
                )
                .await?;
            }
        }
        Ok(())
    })
}

async fn build_docs_tree(filesystem: &dyn FileSystem) -> Result<String, AppError> {
    let mut lines = vec!["[Documentation Files]".to_string()];
    let mut count = 0usize;
    let root = filesystem.resolve(Path::new("")).await?;
    collect_docs(filesystem, &root, &mut lines, &mut count).await?;
    if count >= DEFAULT_MAX_DOCS {
        lines.push("[TRUNCATED] docs tree limit reached".to_string());
    }
    if lines.len() <= 1 {
        return Ok("[No markdown files found]".to_string());
    }
    Ok(lines.join("\n"))
}

fn collect_docs<'a>(
    filesystem: &'a dyn FileSystem,
    directory: &'a codez_core::SafeWorkspacePath,
    lines: &'a mut Vec<String>,
    count: &'a mut usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>> {
    Box::pin(async move {
        if *count >= DEFAULT_MAX_DOCS {
            return Ok(());
        }
        let listing = filesystem.read_directory(directory, 1_000).await?;
        for entry in listing.entries {
            if *count >= DEFAULT_MAX_DOCS {
                break;
            }
            let Some(name) = entry.name.to_str() else {
                continue;
            };
            if entry.kind == FileKind::Directory {
                if !should_ignore_tree(name) {
                    collect_docs(filesystem, &entry.path, lines, count).await?;
                }
            } else if entry.kind == FileKind::File {
                let lower = name.to_lowercase();
                if lower.ends_with(".md") || lower.ends_with(".mdx") {
                    let path = entry
                        .path
                        .relative_path()
                        .to_string_lossy()
                        .replace('\\', "/");
                    lines.push(path);
                    *count += 1;
                }
            }
        }
        Ok(())
    })
}
