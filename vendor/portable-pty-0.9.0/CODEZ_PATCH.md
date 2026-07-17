# CodeZ portable-pty patch

This directory contains the crates.io release of `portable-pty` 0.9.0 under
its original MIT license.

CodeZ changes the Windows `CreatePseudoConsole` flags to `0`. The upstream
release enables `PSEUDOCONSOLE_WIN32_INPUT_MODE`, which expects encoded Win32
input records. CodeZ uses the standard terminal model instead: one ordered
writer forwards VT bytes unchanged, so Ctrl+C is the ETX byte `0x03`.

Using `0` also disables upstream cursor-inheritance and resize-quirk flags.
The release support matrix must therefore smoke-test startup, active output,
cursor behavior, and resize/reflow on every supported Windows version.

Keep this patch until upstream exposes a standard VT input mode or changes its
default flags. Any dependency update must rerun the Windows command prompt,
PowerShell, resize, reader shutdown, and process-tree tests in
`crates/codez-platform/tests/portable_pty_spike.rs`.
