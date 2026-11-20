[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Check', 'Install', 'Run', 'ShowOwnerToken')]
    [string] $Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSEdition -ne 'Desktop') {
    throw 'Use Windows PowerShell 5.1 (powershell.exe) on the deployment desktop.'
}
$workspaceDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentWorkspace'
$bootstrapDir = Join-Path $workspaceDir 'bootstrap'
$installedScript = Join-Path $bootstrapDir 'windows-bootstrap.ps1'
$ownerTokenFile = Join-Path $bootstrapDir 'owner-token.dpapi'
$runtimeFile = Join-Path $bootstrapDir 'runtime.json'
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

function Find-Executable([string] $Name, [string] $Preferred) {
    if ($Preferred -and (Test-Path -LiteralPath $Preferred -PathType Leaf)) {
        return $Preferred
    }
    # Windows PowerShell can return multiple ApplicationInfo objects. Always select one.
    $command = Get-Command -Name $Name -CommandType Application -All -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$command) { throw ('Required executable unavailable: ' + $Name) }
    return [string]$command.Source
}

function Assert-PlainRuntimeFile([string] $Path) {
    if (![IO.Path]::IsPathRooted($Path) -or !(Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Required runtime file is not available.' }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Required runtime file is linked.' }
}

function Read-NodeDistribution([string] $NodePath, [string] $PinnedNpm = '') {
    Assert-PlainRuntimeFile $NodePath
    $nodePath = [IO.Path]::GetFullPath($NodePath)
    if ([IO.Path]::GetFileName($nodePath) -ine 'node.exe') { throw 'Expected node.exe from a complete Node installation.' }
    $npm = Join-Path ([IO.Path]::GetDirectoryName($nodePath)) 'node_modules\npm\bin\npm-cli.js'
    try { Assert-PlainRuntimeFile $npm } catch { throw 'Node 24 or later with bundled npm is required.' }
    if ($PinnedNpm -and (![IO.Path]::IsPathRooted($PinnedNpm) -or [IO.Path]::GetFullPath($PinnedNpm) -ine $npm)) {
        throw 'The pinned bundled npm does not match the Node distribution.'
    }
    $priorOptions = $env:NODE_OPTIONS
    $priorNodePath = $env:NODE_PATH
    try {
        $env:NODE_OPTIONS = $null
        $env:NODE_PATH = $null
        $version = & $nodePath --version
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 24) { throw 'Node 24 or later with bundled npm is required.' }
        $major = [int]$Matches[1]
        $npmVersion = & $nodePath $npm --version
        if ($LASTEXITCODE -ne 0 -or $npmVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'The bundled npm could not start with the selected Node executable.' }
        return [pscustomobject]@{ node = $nodePath; npm = $npm; nodeMajor = $major; npmVersion = $npmVersion }
    } finally {
        $env:NODE_OPTIONS = $priorOptions
        $env:NODE_PATH = $priorNodePath
    }
}

function Find-NodeDistribution([string] $Preferred, [string[]] $Candidates) {
    foreach ($candidate in (@($Preferred) + $Candidates | Where-Object { $_ } | Select-Object -Unique)) {
        try { return Read-NodeDistribution $candidate } catch { }
    }
    throw 'Install an official Node.js 24 or later distribution with bundled npm; standalone or shim node.exe is not sufficient.'
}

function Read-InstallPrerequisites {
    $preferred = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    $candidates = @(Get-Command -Name 'node.exe' -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Source })
    $runtime = Find-NodeDistribution $preferred $candidates
    $git = Find-Executable 'git.exe' (Join-Path $env:ProgramFiles 'Git\cmd\git.exe')
    [void](Get-Command Register-ScheduledTask -ErrorAction Stop)
    return [pscustomobject]@{ node = $runtime.node; npm = $runtime.npm; git = $git; nodeMajor = $runtime.nodeMajor; npmVersion = $runtime.npmVersion }
}

Assert-SafeDirectory $workspaceDir
Assert-SafeDirectory $bootstrapDir
if ($Mode -eq 'Check') {
    $runtime = Read-InstallPrerequisites
    [pscustomobject]@{ nodeMajor = $runtime.nodeMajor; preferredNode = ($runtime.node -ieq (Join-Path $env:ProgramFiles 'nodejs\node.exe')); preferredGit = ($runtime.git -ieq (Join-Path $env:ProgramFiles 'Git\cmd\git.exe')); npmValidated = [bool]$runtime.npmVersion; taskCmdletsAvailable = $true; persisted = 'none' } | ConvertTo-Json -Compress
    return
}
if ($Mode -eq 'Install') {
    $runtime = Read-InstallPrerequisites
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        throw 'The Agent Workspace task already exists; no changes made.'
    }
    $source = Join-Path $PSScriptRoot 'desktop.mjs'
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
        throw 'Use a reviewed checkout containing deploy/desktop.mjs.'
    }
    foreach ($file in @($installedScript, $desktopSupervisor, $ownerTokenFile, $runtimeFile)) {
        if (Test-Path -LiteralPath $file) { throw 'A bootstrap entry already exists; no changes made.' }
    }
    [void][IO.Directory]::CreateDirectory($bootstrapDir)
    [IO.File]::Copy($PSCommandPath, $installedScript, $false)
    [IO.File]::Copy($source, $desktopSupervisor, $false)
    $manifest = [Text.Encoding]::UTF8.GetBytes(($runtime | ConvertTo-Json -Compress))
    $runtimeHandle = [IO.File]::Open($runtimeFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $runtimeHandle.Write($manifest, 0, $manifest.Length) } finally { $runtimeHandle.Dispose() }
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
    $runtimeItem = Get-Item -LiteralPath $runtimeFile -Force
    if ($runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $runtimeItem.Length -gt 4096) { throw 'Pinned executable manifest is invalid.' }
    $runtime = [IO.File]::ReadAllText($runtimeFile) | ConvertFrom-Json
    if (!$runtime.PSObject.Properties['npm'] -or !$runtime.npm) { throw 'Pinned bundled npm is missing. Update the reviewed bootstrap and runtime manifest together.' }
    $nodeRuntime = Read-NodeDistribution $runtime.node $runtime.npm
    foreach ($binary in @{ git = $runtime.git }.GetEnumerator()) {
        if (![IO.Path]::IsPathRooted($binary.Value) -or [IO.Path]::GetFileName($binary.Value) -ine ($binary.Key + '.exe') -or !(Test-Path -LiteralPath $binary.Value -PathType Leaf)) { throw 'A pinned executable is not available.' }
    }
    $bytes = Read-LocalOwnerBytes
    $priorOptions = $env:NODE_OPTIONS
    $priorNodePath = $env:NODE_PATH
    try {
        $env:NODE_OPTIONS = $null
        $env:NODE_PATH = $null
        $env:WORKSPACE_TOKEN = Convert-ToLocalToken $bytes
        $env:WORKSPACE_CD_ROOT = $workspaceDir
        $env:WORKSPACE_REPOSITORY = $repo
        $env:WORKSPACE_CI_WORKFLOW = 'ci.yml'
        $env:WORKSPACE_PORT = '4319'
        $env:WORKSPACE_GIT_EXE = $runtime.git
        $env:WORKSPACE_SECURE_COOKIES = '0'
        $env:WORKSPACE_PUBLIC_ORIGIN = $null
        & $nodeRuntime.node $desktopSupervisor
        $code = $LASTEXITCODE
    } finally {
        $env:WORKSPACE_TOKEN = $null
        $env:NODE_OPTIONS = $priorOptions
        $env:NODE_PATH = $priorNodePath
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
