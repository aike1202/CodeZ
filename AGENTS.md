# Agent Shell Rules

The built-in PowerShell tool configures UTF-8 after permission authorization. Submit only the
business command; do not prepend console encoding setup to tool input.

Use explicit UTF-8 encoding for file operations:

```powershell
Get-Content -Encoding UTF8
Set-Content -Encoding UTF8
Add-Content -Encoding UTF8
Out-File -Encoding UTF8
```

Avoid relying on Windows ANSI/default encoding when handling Chinese paths, logs, source files, JSON, Markdown, or command output.
