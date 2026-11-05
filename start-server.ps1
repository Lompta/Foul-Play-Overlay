# Starts the local analysis server the extension talks to (http://127.0.0.1:8770).
# Leave this window open while using the overlay. Ctrl+C stops it.
#
#   .\start-server.ps1                    # defaults: 1500 ms x 8 sampled worlds
#   .\start-server.ps1 -SearchMs 3000     # think longer
param(
    [int]$SearchMs = 1500,
    [int]$Worlds = 8,
    [int]$Workers = 0
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $here ".venv\Scripts\python.exe"
$argList = @((Join-Path $here "server\overlay_server.py"), "--search-ms", $SearchMs, "--worlds", $Worlds)
if ($Workers -gt 0) { $argList += @("--workers", $Workers) }
& $py @argList
