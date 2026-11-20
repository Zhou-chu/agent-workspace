$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run with Windows PowerShell 5.1' }
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\deploy\windows-bootstrap.ps1'))
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Bootstrap has a PowerShell parse error' }
$selectDefinition = $tree.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-Executable'
}, $true)
if (!$selectDefinition) { throw 'Bootstrap must select an unambiguous executable' }
. ([scriptblock]::Create($selectDefinition.Extent.Text))
function Get-Command {
    [CmdletBinding()]
    param([string]$Name, [string]$CommandType, [switch]$All)
    if ($Name -eq 'missing.exe') { return }
    [pscustomobject]@{Source = 'C:\first\node.exe'}
    [pscustomobject]@{Source = 'C:\second\node.exe'}
}
if ((Find-Executable 'node.exe' '') -cne 'C:\first\node.exe') { throw 'Bootstrap did not return one path when two commands matched' }
try {
    Find-Executable 'missing.exe' '' | Out-Null
    throw 'missing executable was accepted'
} catch {
    if ($_.Exception.Message -notlike 'Required executable unavailable:*') { throw }
}
Write-Output 'PowerShell bootstrap parse and multiple/missing application fixtures passed.'

$distributionChecks = @('Assert-PlainRuntimeFile', 'Read-NodeDistribution', 'Find-NodeDistribution')
foreach ($name in $distributionChecks) {
    $definition = $tree.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (!$definition) { throw ('Bootstrap missing distribution check: ' + $name) }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('agentchat-runtime-fixture-' + [Guid]::NewGuid().ToString('N'))
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    $bareNode = Join-Path $fixture 'node.exe'
    [IO.File]::WriteAllText($bareNode, 'not a Node executable')
    try {
        Read-NodeDistribution $bareNode | Out-Null
        throw 'Standalone Node was accepted'
    } catch {
        if ($_.Exception.Message -notlike '*bundled npm*') { throw }
    }

    # Use the real pinned runtime selected by setup-node, not a mocked npm.
    $actualNode = (Microsoft.PowerShell.Core\Get-Command -Name 'node.exe' -CommandType Application -All | Select-Object -First 1).Source
    $runtime = Read-NodeDistribution $actualNode
    if ($runtime.nodeMajor -lt 24 -or $runtime.npmVersion -notmatch '^\d+\.\d+\.\d+') { throw 'Actual hosted distribution did not validate bundled npm' }
    if ((Find-NodeDistribution $bareNode $actualNode).node -ine $actualNode) { throw 'A bare Node shadowed a complete distribution' }
    try {
        Read-NodeDistribution $actualNode (Join-Path $fixture 'npm-cli.js') | Out-Null
        throw 'Mismatched npm manifest pin was accepted'
    } catch {
        if ($_.Exception.Message -notlike '*bundled npm*') { throw }
    }
} finally {
    [IO.Directory]::Delete($fixture, $true)
}
Write-Output 'Windows distribution prerequisites rejected a standalone executable and validated bundled npm.'
