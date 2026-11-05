# One-time setup: lets the Foul Play Overlay extension start the analysis server
# by itself when you turn FP on, and stop it when you're done.
#
# Registers a Chrome "native messaging host" for your Windows account only
# (HKCU, no admin). Only the extension with this ID may launch it.
# Undo with:  .\install-native-host.ps1 -Uninstall
param([switch]$Uninstall)

$name = "com.justis.foulplay_overlay"
$extensionId = "olkcabjpgbmblenfkohjcophdlfpehca"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$regKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name"
$manifestPath = Join-Path $here "server\$name.json"

if ($Uninstall) {
    Remove-Item $regKey -ErrorAction SilentlyContinue
    Remove-Item $manifestPath -ErrorAction SilentlyContinue
    Write-Host "Removed. The extension can no longer start the server by itself."
    return
}

$manifest = [ordered]@{
    name            = $name
    description     = "Foul Play Overlay analysis server"
    path            = (Join-Path $here "server\native_host.bat")
    type            = "stdio"
    allowed_origins = @("chrome-extension://$extensionId/")
}
# Chrome wants plain UTF-8 (no byte-order mark, which Set-Content would add)
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json))
New-Item $regKey -Force | Out-Null
Set-Item $regKey -Value $manifestPath
Write-Host "Registered $name -> $manifestPath"
