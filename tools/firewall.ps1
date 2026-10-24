# Helm Camera Streams - open the Windows firewall for phones on the Wi-Fi
#
# - allows inbound TCP port 5036 and Node.js (all network profiles)
# - removes block rules for Node.js that Windows creates when the firewall
#   prompt was dismissed on first start (block rules take precedence over allow rules)
# Needs administrator rights and asks for them itself. The result is written to firewall.log.

param([int]$Port = 5036, [string]$NodePath = '', [string]$LogFile = '')

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $LogFile) { $LogFile = Join-Path $Root 'firewall.log' }
if (-not $NodePath) {
    $n = Get-Command node -ErrorAction SilentlyContinue
    if ($n) { $NodePath = $n.Source }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Restart itself with administrator rights (Windows asks)
    $argList = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1} -NodePath "{2}" -LogFile "{3}"' -f `
        $MyInvocation.MyCommand.Path, $Port, $NodePath, $LogFile
    try {
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList $argList
        exit $p.ExitCode
    } catch {
        Write-Host 'Administrator rights were not granted - firewall unchanged.' -ForegroundColor Red
        exit 2
    }
}

function Log([string]$text) {
    Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text)
    Write-Host $text
}

Log "Firewall setup: port $Port, Node.js: $NodePath"
try {
    Get-NetFirewallRule -DisplayName 'Helm Camera Streams*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "Helm Camera Streams (TCP $Port)" -Direction Inbound -Protocol TCP `
        -LocalPort $Port -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Log "Allow rule for TCP port $Port created."
    if ($NodePath) {
        New-NetFirewallRule -DisplayName 'Helm Camera Streams (Node.js)' -Direction Inbound -Program $NodePath `
            -Action Allow -Profile Any -ErrorAction Stop | Out-Null
        Log 'Allow rule for Node.js created.'
        $blocks = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
            Where-Object { $_.Program -and ($_.Program -ieq $NodePath -or [IO.Path]::GetFileName($_.Program) -ieq 'node.exe') } |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' }
        foreach ($b in $blocks) {
            Log ('Block rule for Node.js removed: ' + $b.DisplayName)
            $b | Remove-NetFirewallRule
        }
    }
    Log 'Done.'
    exit 0
} catch {
    Log ('Error: ' + $_.Exception.Message)
    exit 1
}
