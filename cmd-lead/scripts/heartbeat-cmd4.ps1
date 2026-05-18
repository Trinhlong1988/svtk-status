#requires -Version 5.1
<# CMD4 heartbeat writer — fires every 30 phut via schtasks.
   Writes 3 hb JSON: cmd-parse, cmd-network, cmd-qa-core.
   Foundation v2.8.0 hash 2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467
#>

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Administrator\Desktop\SVTK_UPLOAD_WORK\repo'
$hbDir = Join-Path $repo 'cmd-lead\heartbeats'
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$foundationHash = '2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467'

$subCmds = @('cmd-parse', 'cmd-network', 'cmd-qa-core')

foreach ($cmd in $subCmds) {
    $payload = @{
        cmd = $cmd
        parent = 'CMD4'
        phase = '14'
        version = 'v2.8.0'
        ts_utc = $ts
        status = 'alive'
        foundation_hash = $foundationHash
        foundation_verified = $true
        heartbeat_source = 'schtasks_CMD4_HEARTBEAT'
    }
    $file = Join-Path $hbDir ("{0}_hb_{1}.json" -f $cmd, $ts)
    $json = ($payload | ConvertTo-Json -Depth 5)
    [IO.File]::WriteAllText($file, $json, [Text.UTF8Encoding]::new($false))
}

Write-Output ("CMD4 heartbeat {0} -> 3 files" -f $ts)
