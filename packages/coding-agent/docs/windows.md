# Windows installation and setup

## Install the portable binary

Download the Windows archive from the Aira GitHub release:

- `aira-windows-x64.zip` for Intel and AMD PCs.
- `aira-windows-arm64.zip` for Windows on ARM PCs.

Extract it to a stable directory, such as `%LOCALAPPDATA%\\Programs\\Aira`, then
add that directory to your user `Path`. In PowerShell, the following installs the
x64 archive from Downloads and makes `aira` available in new terminals:

```powershell
$installDir = "$env:LOCALAPPDATA\\Programs\\Aira"
New-Item -ItemType Directory -Force -Path $installDir
Expand-Archive -Path "$env:USERPROFILE\\Downloads\\aira-windows-x64.zip" -DestinationPath $installDir -Force
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
}
```

Open a new Windows Terminal window, then verify and start Aira:

```powershell
aira --version
aira
```

Use `/login` on first launch to authenticate. The portable archive does not need
administrator permissions or a separate runtime installation.

## Shell setup

Aira uses Git Bash by default on Windows. Checked locations (in order):

1. Custom path from `~/.aira/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## PowerShell Tool

The optional `powershell` tool runs commands through `pwsh.exe` when available, otherwise Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

Use `defaultTools` to replace the model-facing `bash` tool:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Or enable both while comparing behavior:

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write"]
}
```

The `!` and `!!` editor commands still use Bash.

## Custom Bash Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
