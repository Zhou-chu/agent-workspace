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
