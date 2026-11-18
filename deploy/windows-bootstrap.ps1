[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Run', 'ShowOwnerToken')]
    [string] $Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The Windows bootstrap requires Windows PowerShell on the deployment desktop.'
}
$workspaceDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentWorkspace'
$bootstrapDir = Join-Path $workspaceDir 'bootstrap'
$installedScript = Join-Path $bootstrapDir 'windows-bootstrap.ps1'
$ownerTokenFile = Join-Path $bootstrapDir 'owner-token.dpapi'
$desktopSupervisor = Join-Path $bootstrapDir 'desktop.mjs'
$taskName = 'AgentWorkspace-CD'
$repo = 'Zhou-chu/agent-workspace'

function Assert-SafeDirectory([string] $Directory) {
    if (Test-Path -LiteralPath $Directory) {
        $item = Get-Item -LiteralPath $Directory -Force
        if (!$item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'Expected a real user-owned deployment directory, not a linked path.'
        }
    }
}

function Read-LocalOwnerBytes {
    Add-Type -AssemblyName System.Security
    if (!(Test-Path -LiteralPath $ownerTokenFile -PathType Leaf)) {
        throw 'No owner credential exists for this Windows account.'
    }
    $item = Get-Item -LiteralPath $ownerTokenFile -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -lt 1 -or $item.Length -gt 16384) {
        throw 'Owner credential file is invalid.'
    }
    $payload = [IO.File]::ReadAllBytes($ownerTokenFile)
    $secret = [Security.Cryptography.ProtectedData]::Unprotect($payload, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($secret.Length -ne 32) {
        [Array]::Clear($secret, 0, $secret.Length)
        throw 'Owner credential could not be verified.'
    }
    return ,$secret
}

function Convert-ToLocalToken([byte[]] $Bytes) {
    return [BitConverter]::ToString($Bytes).Replace('-', '').ToLowerInvariant()
}

Assert-SafeDirectory $workspaceDir
Assert-SafeDirectory $bootstrapDir
if ($Mode -eq 'Install') {
    $nodeExe = (Get-Command node.exe -CommandType Application).Source
    $gitExe = (Get-Command git.exe -CommandType Application).Source
    $nodeMajor = & $nodeExe -p 'process.versions.node.split(".")[0]'
    if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 24 -or !$gitExe) {
        throw 'Install official Node.js 24 or later and Git first.'
    }
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        throw 'The Agent Workspace task already exists; no changes made.'
    }
    $source = Join-Path $PSScriptRoot 'desktop.mjs'
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
        throw 'Use a reviewed checkout containing deploy/desktop.mjs.'
    }
    foreach ($file in @($installedScript, $desktopSupervisor, $ownerTokenFile)) {
        if (Test-Path -LiteralPath $file) { throw 'A bootstrap entry already exists; no changes made.' }
    }
    [void][IO.Directory]::CreateDirectory($bootstrapDir)
    [IO.File]::Copy($PSCommandPath, $installedScript, $false)
    [IO.File]::Copy($source, $desktopSupervisor, $false)
    Add-Type -AssemblyName System.Security
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        $cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $file = [IO.File]::Open($ownerTokenFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($cipher, 0, $cipher.Length) } finally { $file.Dispose() }
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $rng.Dispose()
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    # No token or elevation flag is stored in the scheduler task.
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $installedScript + '" -Mode Run'
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $arguments -WorkingDirectory $bootstrapDir
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Pull and run CI-verified Agent Workspace main on local loopback.' | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output 'Agent Workspace desktop task registered and start requested; check /healthz and exact active.json before reporting deployment.'
    return
}

if ($Mode -eq 'Run') {
    if (![string]::Equals([IO.Path]::GetFullPath($PSCommandPath), [IO.Path]::GetFullPath($installedScript), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Run mode requires the installed reviewed bootstrap.'
    }
    $nodeExe = (Get-Command node.exe -CommandType Application).Source
    $bytes = Read-LocalOwnerBytes
    try {
        $env:WORKSPACE_TOKEN = Convert-ToLocalToken $bytes
        $env:WORKSPACE_CD_ROOT = $workspaceDir
        $env:WORKSPACE_REPOSITORY = $repo
        $env:WORKSPACE_CI_WORKFLOW = 'ci.yml'
        $env:WORKSPACE_PORT = '4319'
        $env:WORKSPACE_SECURE_COOKIES = '0'
        $env:WORKSPACE_PUBLIC_ORIGIN = $null
        & $nodeExe $desktopSupervisor
        $code = $LASTEXITCODE
    } finally {
        $env:WORKSPACE_TOKEN = $null
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
    exit $code
}

if (![Environment]::UserInteractive) { throw 'Retrieve the credential only from the local interactive Windows desktop.' }
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'Agent Workspace owner key'
$form.Width = 595
$form.Height = 145
$form.StartPosition = 'CenterScreen'
$field = New-Object Windows.Forms.TextBox
$field.Left = 15
$field.Top = 20
$field.Width = 550
$field.ReadOnly = $true
$field.UseSystemPasswordChar = $true
$toggle = New-Object Windows.Forms.Button
$toggle.Left = 15
$toggle.Top = 53
$toggle.Width = 143
$toggle.Text = 'Reveal on this device'
$toggle.Add_Click({
    if ($field.UseSystemPasswordChar) {
        $localBytes = Read-LocalOwnerBytes
        try { $field.Text = Convert-ToLocalToken $localBytes } finally { [Array]::Clear($localBytes, 0, $localBytes.Length) }
        $field.UseSystemPasswordChar = $false
        $toggle.Text = 'Hide'
    } else {
        $field.Clear()
        $field.UseSystemPasswordChar = $true
        $toggle.Text = 'Reveal on this device'
    }
})
$form.Controls.Add($field)
$form.Controls.Add($toggle)
try { [void]$form.ShowDialog() } finally { $field.Clear(); $form.Dispose() }
