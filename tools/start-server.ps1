# Helm Camera Streams - Test auf dem Windows-PC (wird von start.bat gestartet)
#
# - prueft Node.js (bietet Installation per winget an), installiert Pakete beim ersten Start
# - ermittelt die IP-Adresse des PCs im Netzwerk
# - startet den Server auf Port 5036 und oeffnet das Admin-Fenster unter http://<PC-IP>:5036/admin/
# - schreibt alles zusaetzlich nach start.log
# Laeuft mit Windows PowerShell 5.1 und PowerShell 7.

# Nicht 'Stop': Windows PowerShell 5.1 wuerde sonst bei jeder Warnung von npm/node abbrechen
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Port = 5036
$LogFile = Join-Path $Root 'start.log'

function Say([string]$text, [string]$color = 'Gray') {
    Write-Host $text -ForegroundColor $color
    Add-Content -Path $LogFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $text)
}

# IPv4-Adresse der Netzwerkkarte mit Standard-Gateway (WLAN/LAN), sonst localhost
function Get-LanIp {
    try {
        $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {
            $_.OperationalStatus -eq 'Up' -and
            $_.NetworkInterfaceType -ne 'Loopback' -and
            $_.Description -notmatch 'Virtual|VMware|Hyper-V|VirtualBox|vEthernet|Loopback|TAP|WSL'
        }
        foreach ($nic in $nics) {
            $props = $nic.GetIPProperties()
            $gw = $props.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne '0.0.0.0' }
            if (-not $gw) { continue }
            $ip = $props.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
            if ($ip) { return $ip.Address.ToString() }
        }
    } catch { }
    return 'localhost'
}

Set-Content -Path $LogFile -Value ('Start ' + (Get-Date)) -Encoding UTF8
Write-Host ''
Write-Host '  Helm Camera Streams - Test am PC' -ForegroundColor Cyan
Write-Host '  ================================' -ForegroundColor Cyan
Write-Host ''

# ---- Node.js ------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Say 'Node.js ist nicht installiert.' 'Yellow'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $answer = Read-Host 'Node.js jetzt mit winget installieren? (j/n)'
        if ($answer -match '^[jJyY]') {
            winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            Say 'Node.js wurde installiert. Bitte dieses Fenster schliessen und start.bat erneut starten.' 'Green'
            exit 0
        }
    }
    Say 'Bitte Node.js LTS von https://nodejs.org installieren und start.bat erneut starten.' 'Yellow'
    exit 1
}
$nodeVersion = (& node --version).Trim()
Say "Node.js $nodeVersion gefunden."
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 18) {
    Say 'Node.js ist zu alt (mindestens Version 18 noetig). Bitte Node.js LTS von https://nodejs.org installieren.' 'Red'
    exit 1
}

# ---- Pakete ---------------------------------------------------------------
if (-not (Test-Path (Join-Path $Root 'node_modules\ws\package.json'))) {
    Say 'Pakete werden installiert (einmalig, braucht Internet) ...'
    & npm ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Say ([string]$_) }
    if ($LASTEXITCODE -ne 0) {
        Say 'Installation fehlgeschlagen. Internetverbindung pruefen.' 'Red'
        exit 1
    }
}

# ---- ffmpeg (optional) ------------------------------------------------------
$localFfmpeg = Join-Path $Root 'tools\ffmpeg\bin\ffmpeg.exe'
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Say 'ffmpeg gefunden: HLS und MPEG-TS verfuegbar.'
} elseif (Test-Path $localFfmpeg) {
    $env:FFMPEG_PATH = $localFfmpeg
    Say 'ffmpeg aus tools\ffmpeg gefunden: HLS und MPEG-TS verfuegbar.'
} else {
    Say 'Hinweis: ffmpeg nicht gefunden - nur der MJPEG-Link funktioniert.' 'Yellow'
    Say '         Fuer HLS/MPEG-TS: "winget install Gyan.FFmpeg" oder ffmpeg nach tools\ffmpeg\bin\ legen.' 'Yellow'
}

# ---- Adresse ------------------------------------------------------------------
$ip = Get-LanIp
$base = "http://${ip}:$Port"
$env:PORT = "$Port"
$env:DATA_DIR = Join-Path $Root 'data'
$env:PUBLIC_URL = $base

Write-Host ''
Say "Admin:   $base/admin/   (erster Login: admin / admin123)" 'Green'
Say "Daten:   $($env:DATA_DIR)"
Write-Host ''
Write-Host '  Handys im selben WLAN erreichen den Server unter dieser Adresse.'
Write-Host '  Fragt Windows nach der Firewall, "Zugriff zulassen" waehlen (privates Netzwerk).'
Write-Host ''
Write-Host '  Bluetooth im Browser braucht HTTPS. Zum Testen ueber die PC-IP in Chrome einmalig'
Write-Host "  chrome://flags/#unsafely-treat-insecure-origin-as-secure oeffnen, $base eintragen,"
Write-Host '  auf "Enabled" stellen und Chrome neu starten (am PC und am Android-Handy).'
Write-Host '  Am PC selbst geht es auch ohne Flag ueber http://localhost:5036.'
Write-Host ''
Write-Host '  Dieses Fenster offen lassen. Zum Beenden schliessen oder Strg+C.' -ForegroundColor Cyan
Write-Host ''

# Browser kurz nach dem Serverstart oeffnen
if (-not $env:HELM_NO_BROWSER) {
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList "$base/admin/" | Out-Null
}

& node server.js 2>&1 | ForEach-Object { Say ([string]$_) }
Say "Server beendet (Code $LASTEXITCODE)." 'Yellow'
