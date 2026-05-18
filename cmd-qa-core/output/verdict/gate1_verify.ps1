#requires -Version 5.1
<# CMD4 GATE 1 — 17 criteria verifier (Tuần 3).
   Verdict JSON → cmd-lead/completions/QA_VERDICT_{ts}.json
   Foundation v2.8.0 hash 2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467
#>

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Administrator\Desktop\SVTK_UPLOAD_WORK\repo'
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$foundationHash = '2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467'

function Check {
    param([string]$id, [string]$desc, [scriptblock]$test)
    $ok = $false
    $detail = ''
    try { $ok = & $test; if ($ok -is [object] -and $ok.GetType().Name -eq 'PSCustomObject') { $detail = $ok.detail; $ok = $ok.ok } }
    catch { $detail = $_.Exception.Message }
    [pscustomobject]@{ id = $id; desc = $desc; pass = [bool]$ok; detail = $detail }
}

$criteria = @()

$criteria += Check 'G1.01' 'cmd-parse folder exists' { Test-Path "$repo\cmd-parse" -PathType Container }
$criteria += Check 'G1.02' 'cmd-network folder exists (NEW)' { Test-Path "$repo\cmd-network" -PathType Container }
$criteria += Check 'G1.03' 'cmd-qa-core folder exists' { Test-Path "$repo\cmd-qa-core" -PathType Container }
$criteria += Check 'G1.04' 'cmd-parse/cmd.md present' { Test-Path "$repo\cmd-parse\cmd.md" }
$criteria += Check 'G1.05' 'cmd-network/cmd.md present (NEW spec)' { Test-Path "$repo\cmd-network\cmd.md" }
$criteria += Check 'G1.06' 'cmd-qa-core/cmd.md present' { Test-Path "$repo\cmd-qa-core\cmd.md" }
$criteria += Check 'G1.07' 'cmd-parse/output/anti_bot/ has >=7 .ts' { (Get-ChildItem "$repo\cmd-parse\output\anti_bot" -Filter *.ts -ErrorAction SilentlyContinue).Count -ge 7 }
$criteria += Check 'G1.08' 'cmd-parse/output/auth/ has >=5 .ts (legacy)' { (Get-ChildItem "$repo\cmd-parse\output\auth" -Filter *.ts -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'r66_session_token.ts' }).Count -ge 5 }
$criteria += Check 'G1.09' 'R66 cmd-parse/output/auth/r66_session_token.ts (Tuan 2)' { Test-Path "$repo\cmd-parse\output\auth\r66_session_token.ts" }
$criteria += Check 'G1.10' 'R69 cmd-network/output/r69/packet_envelope.ts' { Test-Path "$repo\cmd-network\output\r69\packet_envelope.ts" }
$criteria += Check 'G1.11' 'R69 cmd-network/output/r69/replay_cache.ts' { Test-Path "$repo\cmd-network\output\r69\replay_cache.ts" }
$criteria += Check 'G1.12' 'combat_network_adapter.ts ported' { Test-Path "$repo\cmd-network\output\combat_adapter\combat_network_adapter.ts" }
$criteria += Check 'G1.13' 'cmd-qa-core/output/anti_cheat/ >=1 .ts' { (Get-ChildItem "$repo\cmd-qa-core\output\anti_cheat" -Filter *.ts -ErrorAction SilentlyContinue).Count -ge 1 }
$criteria += Check 'G1.14' 'cmd-qa-core/output/audit/ >=5 audit hooks' { (Get-ChildItem "$repo\cmd-qa-core\output\audit" -Filter *.ts -ErrorAction SilentlyContinue).Count -ge 5 }
$criteria += Check 'G1.15' 'cmd-qa-core/docs/mutation_94pct.md (R10-R18)' { Test-Path "$repo\cmd-qa-core\docs\mutation_94pct.md" }
$criteria += Check 'G1.16' 'Foundation v2.8.0 hash match (canonical LF)' {
    $fp = "$repo\foundation\SVTK_FOUNDATION_v2.8.0.md"
    if (-not (Test-Path $fp)) { return $false }
    # Normalize CRLF -> LF (git autocrlf=true converts on checkout; INDEX.sha256
    # records the canonical LF hash matching the git blob).
    $bytes = [IO.File]::ReadAllBytes($fp)
    $text = [Text.Encoding]::UTF8.GetString($bytes) -replace "`r`n", "`n"
    $lfBytes = [Text.Encoding]::UTF8.GetBytes($text)
    $sha = [Security.Cryptography.SHA256]::Create()
    $h = ([BitConverter]::ToString($sha.ComputeHash($lfBytes))).Replace('-', '').ToLower()
    $h -eq $foundationHash
}
$criteria += Check 'G1.17' 'Heartbeat schtask SVTK_CMD4_HEARTBEAT registered' {
    $q = schtasks /Query /TN 'SVTK_CMD4_HEARTBEAT' /FO CSV 2>$null
    $q -and ($q -notmatch 'ERROR')
}

$passCount = ($criteria | Where-Object pass).Count
$total = $criteria.Count
$pct = if ($total -gt 0) { [Math]::Round($passCount * 100.0 / $total, 1) } else { 0 }
$verdict = if ($pct -ge 95) { 'PASS' } elseif ($pct -ge 80) { 'NEED_REVIEW' } else { 'FAIL' }

$report = [ordered]@{
    cmd = 'cmd-qa-core'
    parent = 'CMD4'
    phase = '14'
    version = 'v2.8.0'
    week = 'Tuan 3 — GATE 1 verify'
    ts_utc = $ts
    foundation_hash = $foundationHash
    foundation_verified = ($criteria | Where-Object id -eq 'G1.16').pass
    pass_count = $passCount
    total = $total
    pct = $pct
    verdict = $verdict
    criteria = $criteria
}

$verdictDir = "$repo\cmd-qa-core\output\verdict"
$out1 = Join-Path $verdictDir ("QA-VERDICT-{0}.json" -f $ts)
$out2 = Join-Path "$repo\cmd-lead\completions" ("QA_VERDICT_{0}.json" -f $ts)
$json = $report | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($out1, $json, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($out2, $json, [Text.UTF8Encoding]::new($false))

Write-Output ("GATE 1: {0}/{1} ({2}%) -> {3}" -f $passCount, $total, $pct, $verdict)
Write-Output ("Verdict: {0}" -f $out2)
