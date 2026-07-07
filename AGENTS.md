# Agent Shell Rules

When running PowerShell commands in this repository, initialize UTF-8 before commands that may read or print Chinese text:

```powershell
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null
```

Use explicit UTF-8 encoding for file operations:

```powershell
Get-Content -Encoding UTF8
Set-Content -Encoding UTF8
Add-Content -Encoding UTF8
Out-File -Encoding UTF8
```

Avoid relying on Windows ANSI/default encoding when handling Chinese paths, logs, source files, JSON, Markdown, or command output.
