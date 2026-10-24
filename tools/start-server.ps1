# Helm Camera Streams - Test auf dem Windows-PC (wird von start.bat gestartet)
#
# - prueft Node.js (bietet Installation per winget an), installiert Pakete beim ersten Start
# - ermittelt die IP-Adresse des PCs im Netzwerk
# - erzeugt eigene HTTPS-Zertifikate (Test-CA, wird in Windows eingetragen)
# - startet den Server auf Port 5036 und oeffnet das Admin-Fenster unter https://<PC-IP>:5036/admin/
# - schreibt alles zusaetzlich nach start.log
# Laeuft mit Windows PowerShell 5.1 und PowerShell 7.

# Nicht 'Stop': Windows PowerShell 5.1 wuerde sonst bei jeder Warnung von npm/node abbrechen
$ErrorActionPreference = 'Continue'
# Node.js gibt UTF-8 aus; sonst zeigt Windows PowerShell 5.1 Umlaute falsch an
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Port = 5036
$LogFile = Join-Path $Root 'start.log'

# Fehlerausgaben (stderr) von node/npm als normalen Text anzeigen
function Clean($line) {
    if ($line -is [System.Management.Automation.ErrorRecord]) { $line = $line.Exception.Message }
    $line = [string]$line
    if ($line -eq 'System.Management.Automation.RemoteException') { return '' }
    return $line
}

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

# ---- Pakete (neu installieren, wenn sich package-lock.json geaendert hat) ---
$lockHash = (Get-FileHash (Join-Path $Root 'package-lock.json')).Hash
$marker = Join-Path $Root 'node_modules\.helm-installed'
$installed = ''
if (Test-Path $marker) { $installed = (Get-Content $marker -Raw).Trim() }
if ($installed -ne $lockHash) {
    Say 'Pakete werden installiert (braucht Internet) ...'
    & npm ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Say (Clean $_) }
    if ($LASTEXITCODE -ne 0) {
        Say 'Installation fehlgeschlagen. Internetverbindung pruefen.' 'Red'
        exit 1
    }
    Set-Content -Path $marker -Value $lockHash
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

# ---- Alten Server auf dem Port beenden ----------------------------------------
function Stop-OldServer {
    try { $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { return }
    foreach ($c in $conns) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'server\.js') {
            Say "Alter Server auf Port $Port (PID $($proc.ProcessId)) wird beendet." 'Yellow'
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } else {
            Say "Port $Port wird schon von '$($proc.Name)' (PID $($proc.ProcessId)) benutzt. Bitte dieses Programm beenden." 'Red'
            exit 1
        }
    }
}
Stop-OldServer

# ---- Windows-Firewall: Port fuer Handys im WLAN freigeben ----------------------
function Test-FirewallOk {
    try {
        if (-not (Get-NetFirewallRule -DisplayName "Helm Camera Streams (TCP $Port)" -ErrorAction SilentlyContinue)) { return $false }
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        $blocked = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
            Where-Object { $_.Program -and ($_.Program -ieq $node -or [IO.Path]::GetFileName($_.Program) -ieq 'node.exe') } |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
        return -not $blocked
    } catch { return $true } # Firewall nicht abfragbar: nichts tun
}

function Enable-Firewall {
    if ($env:OS -ne 'Windows_NT') { return }
    if (Test-FirewallOk) { return }
    Say "Firewall: Port $Port und Node.js werden fuer Handys im Netzwerk freigegeben." 'Yellow'
    Say "          Windows fragt gleich nach Administrator-Rechten - bitte 'Ja' waehlen." 'Yellow'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\firewall.ps1') -Port $Port | Out-Null
    if (Test-FirewallOk) {
        Say 'Firewall freigegeben.' 'Green'
    } else {
        Say 'Firewall NICHT freigegeben - Handys erreichen den PC evtl. nicht.' 'Red'
        Say '  Loesung: firewall.bat doppelklicken und "Ja" waehlen. Details stehen in firewall.log.' 'Red'
    }
}
Enable-Firewall

# ---- Adresse und eigene HTTPS-Zertifikate --------------------------------------
$ip = Get-LanIp
$env:PORT = "$Port"
$env:DATA_DIR = Join-Path $Root 'data'
$certDir = Join-Path $env:DATA_DIR 'certs'
$caFile = $null
& node (Join-Path $Root 'tools\make-cert.js') $certDir $ip 2>&1 | ForEach-Object {
    $line = Clean $_
    if ($line -match 'ca\.crt$') { $caFile = $line } elseif ($line) { Say $line }
}

if ($caFile -and (Test-Path $caFile)) {
    $base = "https://${ip}:$Port"
    $env:TLS_CERT = Join-Path $certDir 'server.crt'
    $env:TLS_KEY = Join-Path $certDir 'server.key'
    $env:TEST_CA_FILE = $caFile

    # Test-CA einmalig in Windows als vertrauenswuerdig eintragen (Chrome/Edge nutzen den Windows-Speicher)
    if ($env:OS -eq 'Windows_NT') {
        try {
            $ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caFile)
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
            $store.Open('ReadWrite')
            $known = $store.Certificates | Where-Object { $_.Thumbprint -eq $ca.Thumbprint }
            if (-not $known) {
                Say 'Windows fragt gleich, ob das Test-Zertifikat installiert werden soll: bitte "Ja" waehlen.' 'Yellow'
                $store.Add($ca)
                Say 'Test-Zertifikat in Windows eingetragen. Falls der Browser noch warnt: Browser neu starten.' 'Green'
            }
            $store.Close()
        } catch {
            Say 'Test-Zertifikat wurde nicht eingetragen - der Browser zeigt dann eine Warnung ("Erweitert -> Weiter").' 'Yellow'
        }
    }
} else {
    Say 'Zertifikat konnte nicht erzeugt werden - Server laeuft ohne HTTPS (Bluetooth nur ueber localhost).' 'Yellow'
    $base = "http://${ip}:$Port"
}
$env:PUBLIC_URL = $base

Write-Host ''
Say "Admin:   $base/admin/   (erster Login: admin / admin123)" 'Green'
Say "Daten:   $($env:DATA_DIR)"
try {
    $others = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne $ip } |
        ForEach-Object { $_.Address.ToString() }
    if ($others) { Say ("Andere Adressen dieses PCs: " + ($others -join ', ') + "  (falls das Handy die obige nicht erreicht)") }
} catch { }
Write-Host ''
Write-Host '  Handys im selben WLAN erreichen den Server unter dieser Adresse.'
Write-Host '  Laedt die Seite am Handy nicht: Handy im selben WLAN? (kein Gaeste-WLAN, keine mobilen Daten)'
Write-Host '  Fragt Windows nach der Firewall, "Zugriff zulassen" waehlen (privat UND oeffentlich).'
Write-Host '  iPhone: Bluetooth geht nur in der App "Bluefy" - die Handy-Seite zeigt den Weg dorthin.'
if ($env:TEST_CA_FILE) {
    Write-Host ''
    Write-Host '  Handys einmalig: im Admin bei einem Stream "QR / Links" oeffnen und den QR-Code'
    Write-Host '  "Zertifikat fuers Handy" scannen, Datei laden und als CA-Zertifikat installieren.'
    Write-Host "  (Direkt: $base/ca.crt)"
}
Write-Host ''
Write-Host '  Dieses Fenster offen lassen. Zum Beenden schliessen oder Strg+C.' -ForegroundColor Cyan
Write-Host ''

# Browser kurz nach dem Serverstart oeffnen
if (-not $env:HELM_NO_BROWSER) {
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList "$base/admin/" | Out-Null
}

& node (Join-Path $Root 'server.js') 2>&1 | ForEach-Object { Say (Clean $_) }
Say "Server beendet (Code $LASTEXITCODE)." 'Yellow'
