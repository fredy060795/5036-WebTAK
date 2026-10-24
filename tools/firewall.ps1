# Helm Camera Streams - Windows-Firewall fuer Handys im WLAN freigeben
#
# - erlaubt eingehend TCP-Port 5036 und Node.js (alle Netzwerkprofile)
# - entfernt Sperr-Regeln fuer Node.js, die Windows anlegt, wenn man den
#   Firewall-Hinweis beim ersten Start weggeklickt hat (Sperren gehen vor Freigaben)
# Braucht Administrator-Rechte und fragt selbst danach. Ergebnis steht in firewall.log.

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
    # Sich selbst mit Administrator-Rechten neu starten (Windows fragt nach)
    $argList = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1} -NodePath "{2}" -LogFile "{3}"' -f `
        $MyInvocation.MyCommand.Path, $Port, $NodePath, $LogFile
    try {
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList $argList
        exit $p.ExitCode
    } catch {
        Write-Host 'Administrator-Rechte wurden nicht erteilt - Firewall unveraendert.' -ForegroundColor Red
        exit 2
    }
}

function Log([string]$text) {
    Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text)
    Write-Host $text
}

Log "Firewall-Einrichtung: Port $Port, Node.js: $NodePath"
try {
    Get-NetFirewallRule -DisplayName 'Helm Camera Streams*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "Helm Camera Streams (TCP $Port)" -Direction Inbound -Protocol TCP `
        -LocalPort $Port -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Log "Freigabe fuer TCP-Port $Port angelegt."
    if ($NodePath) {
        New-NetFirewallRule -DisplayName 'Helm Camera Streams (Node.js)' -Direction Inbound -Program $NodePath `
            -Action Allow -Profile Any -ErrorAction Stop | Out-Null
        Log 'Freigabe fuer Node.js angelegt.'
        $blocks = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
            Where-Object { $_.Program -and ($_.Program -ieq $NodePath -or [IO.Path]::GetFileName($_.Program) -ieq 'node.exe') } |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' }
        foreach ($b in $blocks) {
            Log ('Sperr-Regel fuer Node.js entfernt: ' + $b.DisplayName)
            $b | Remove-NetFirewallRule
        }
    }
    Log 'Fertig.'
    exit 0
} catch {
    Log ('Fehler: ' + $_.Exception.Message)
    exit 1
}
