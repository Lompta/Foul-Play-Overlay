# Runs Foul Play itself as a Showdown bot that accepts Gen 9 Random Battle
# challenges, so you can play against it (with the overlay on, if you like).
#
# Use a separate Showdown account for the bot. You type its password at the
# prompt; it isn't stored anywhere.
#
#   .\run-sparring-bot.ps1 -Username "MyFoulPlayBot" [-Games 5] [-SearchMs 1000]
param(
    [Parameter(Mandatory = $true)][string]$Username,
    [int]$Games = 1,
    [int]$SearchMs = 1000,
    [int]$Parallelism = 4
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $here ".venv\Scripts\python.exe"
$secure = Read-Host "Showdown password for $Username" -AsSecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

Push-Location (Join-Path $here "vendor\foul-play")
try {
    Write-Host "Waiting for challenges to $Username (Gen 9 Random Battle). Ctrl+C to stop."
    & $py run.py `
        --websocket-uri wss://sim3.psim.us/showdown/websocket `
        --ps-username $Username --ps-password $password `
        --bot-mode accept_challenge --pokemon-format gen9randombattle `
        --run-count $Games --search-time-ms $SearchMs --search-parallelism $Parallelism `
        --log-level INFO
} finally {
    $password = $null
    Pop-Location
}
