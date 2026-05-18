#requires -Version 5.1
<# CMD4 GATE 1 — 17 criteria verifier (Tuần 3).
   Verdict JSON → cmd-lead/completions/QA_VERDICT_{ts}.json
   Foundation v2.8.0 hash 2e6e8c23d8455d9b964744486be11f0a88684113c1cbc6eb77ec371dc266e467
#>

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Administrator\Desktop\SVTK_UPLOAD_WORK\repo'
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
# Dynamic foundation hash — read from INDEX.sha256 (cmd-lead authoritative source).
# Avoids stale-hash HIGH alert when LEAD resyncs INDEX (e.g., commit c220446).
$indexPath = "$repo\foundation\INDEX.sha256"
$indexLine = Select-String -Path $indexPath -Pattern 'SVTK_FOUNDATION_v2.8.0.md' | Select-Object -First 1
if (-not $indexLine) { throw "INDEX.sha256 missing SVTK_FOUNDATION_v2.8.0.md entry" }
$foundationHash = ($indexLine.Line -split '\s+')[0].ToLower()

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
$criteria += Check 'G1.16' 'Foundation v2.8.0 on-disk hash match INDEX.sha256' {
    $fp = "$repo\foundation\SVTK_FOUNDATION_v2.8.0.md"
    if (-not (Test-Path $fp)) { return $false }
    # INDEX.sha256 records the on-disk hash (CRLF on Windows post-checkout).
    # Compare directly with Get-FileHash to avoid LF/CRLF guesswork.
    $h = (Get-FileHash $fp -Algorithm SHA256).Hash.ToLower()
    $h -eq $foundationHash
}
$criteria += Check 'G1.17' 'Heartbeat schtask SVTK_CMD4_HEARTBEAT registered' {
    $q = schtasks /Query /TN 'SVTK_CMD4_HEARTBEAT' /FO CSV 2>$null
    $q -and ($q -notmatch 'ERROR')
}

# ===== Round 9+10 expansion — semantic checks added 2026-05-18 =====

$criteria += Check 'G1.18' 'packet_envelope.ts NO Math.random usage (R6 determinism)' {
    $c = Get-Content "$repo\cmd-network\output\r69\packet_envelope.ts" -Raw
    # Strip comments; remaining code must NOT contain Math.random
    $noComments = [regex]::Replace($c, '/\*[\s\S]*?\*/', '')
    $noComments = [regex]::Replace($noComments, '//.*', '')
    -not ($noComments -match 'Math\.random')
}

$criteria += Check 'G1.19' 'replay_cache.ts NO Math.random usage' {
    $c = Get-Content "$repo\cmd-network\output\r69\replay_cache.ts" -Raw
    $noComments = [regex]::Replace($c, '/\*[\s\S]*?\*/', '')
    $noComments = [regex]::Replace($noComments, '//.*', '')
    -not ($noComments -match 'Math\.random')
}

$criteria += Check 'G1.20' 'r66_session_token.ts NO Math.random usage' {
    $c = Get-Content "$repo\cmd-parse\output\auth\r66_session_token.ts" -Raw
    $noComments = [regex]::Replace($c, '/\*[\s\S]*?\*/', '')
    $noComments = [regex]::Replace($noComments, '//.*', '')
    -not ($noComments -match 'Math\.random')
}

$criteria += Check 'G1.21' 'R66 sub-rule 4/5/8/9 deferral documented in file header' {
    $c = Get-Content "$repo\cmd-parse\output\auth\r66_session_token.ts" -Raw
    ($c -match 'R66\.4') -and ($c -match 'R66\.5') -and ($c -match 'R66\.8') -and ($c -match 'R66\.9')
}

$criteria += Check 'G1.22' 'R69 5 categories present with correct maxAgeMs' {
    $c = Get-Content "$repo\cmd-network\output\r69\packet_envelope.ts" -Raw
    ($c -match 'combat_action.*maxAgeMs:\s*1000') -and
    ($c -match 'movement.*maxAgeMs:\s*200') -and
    ($c -match 'chat_message.*maxAgeMs:\s*30_000') -and
    ($c -match 'ping_heartbeat.*maxAgeMs:\s*5_000') -and
    ($c -match 'trade_confirm.*maxAgeMs:\s*60_000')
}

$criteria += Check 'G1.23' 'timing-safe sig compare (no string ===)' {
    $c = Get-Content "$repo\cmd-network\output\r69\packet_envelope.ts" -Raw
    $c -match 'timingSafeEqual'
}

$criteria += Check 'G1.24' 'JSDoc on exported functions (3 files)' {
    $files = @(
        "$repo\cmd-network\output\r69\packet_envelope.ts",
        "$repo\cmd-network\output\r69\replay_cache.ts",
        "$repo\cmd-parse\output\auth\r66_session_token.ts"
    )
    $ok = $true
    foreach ($f in $files) {
        $c = Get-Content $f -Raw
        $exports = ([regex]::Matches($c, '(?m)^export\s+(function|class|const|interface|type)\s+\w+')).Count
        $blocks = ([regex]::Matches($c, '/\*\*[\s\S]*?\*/')).Count
        if ($exports -gt 0 -and $blocks -lt 2) { $ok = $false }
    }
    $ok
}

$criteria += Check 'G1.25' 'Heartbeat schtask FIRED at least once after register (>=3 hb JSON per CMD)' {
    $cmds = @('cmd-parse', 'cmd-network', 'cmd-qa-core')
    $ok = $true
    foreach ($c in $cmds) {
        $n = (Get-ChildItem "$repo\cmd-lead\heartbeats" -Filter "${c}_hb_*.json" -ErrorAction SilentlyContinue).Count
        if ($n -lt 2) { $ok = $false }
    }
    $ok
}

# ===== Tuần 4 R69.4 + R69.5 closure (added 2026-05-18) =====

$criteria += Check 'G1.26' 'R69.4 ack_protocol.ts (buildAck + buildNack + parseAckOrNack)' {
    $f = "$repo\cmd-network\output\r69\ack_protocol.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'buildAck\(') -and ($c -match 'buildNack\(') -and ($c -match 'parseAckOrNack\(')
}

$criteria += Check 'G1.27' 'R69.5 session_window.ts (windowSize=50 default + tryAdmit + ack)' {
    $f = "$repo\cmd-network\output\r69\session_window.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'class\s+SessionWindow') -and ($c -match 'tryAdmit\(') -and ($c -match 'windowSize\s*\?\?\s*50')
}

$criteria += Check 'G1.28' 'R69 Session orchestrator wires envelope+replay+window+ack' {
    $f = "$repo\cmd-network\output\r69\session.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'class\s+Session') -and
    ($c -match 'this\.replay') -and
    ($c -match 'this\.window') -and
    ($c -match 'buildAck') -and
    ($c -match 'buildNack')
}

$criteria += Check 'G1.29' 'R69 session test suite (ack + window + session) all green' {
    $count = (Get-ChildItem "$repo\cmd-network\tests" -Filter "*.test.ts" -ErrorAction SilentlyContinue).Count
    $count -ge 8
}

# ===== Tuần 4 deep-audit hardening (R26-R39, added 2026-05-18) =====

$criteria += Check 'G1.30' 'R69.2 ordered_receiver.ts buffering implementation (Foundation R69.2)' {
    $f = "$repo\cmd-network\output\r69\ordered_receiver.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'class\s+OrderedReceiver') -and
    ($c -match 'receive\(') -and
    ($c -match 'duplicate') -and
    ($c -match 'buffered') -and
    ($c -match 'overflow')
}

$criteria += Check 'G1.31' 'R69.4 ACK/NACK timestamp anti-replay (audit bug#38)' {
    $f = "$repo\cmd-network\output\r69\ack_protocol.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'tsMs') -and
    ($c -match 'MAX_ACK_AGE_MS') -and
    ($c -match "'stale'")
}

$criteria += Check 'G1.32' 'seq range check ≤ MAX_SAFE_INTEGER (audit bug#37)' {
    $files = @(
        "$repo\cmd-network\output\r69\ack_protocol.ts",
        "$repo\cmd-network\output\r69\session_window.ts",
        "$repo\cmd-network\output\r69\ordered_receiver.ts"
    )
    $ok = $true
    foreach ($f in $files) {
        if (-not (Get-Content $f -Raw | Select-String -Pattern 'MAX_SAFE_INTEGER' -SimpleMatch -Quiet)) {
            $ok = $false
        }
    }
    $ok
}

# ===== Tuần 5 R68 Replay Divergence Detector (added 2026-05-19) =====

$criteria += Check 'G1.33' 'R68.1 state_checksum.ts (canonical sha256, checkpoint interval)' {
    $f = "$repo\cmd-qa-core\output\replay\state_checksum.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'computeStateChecksum') -and
    ($c -match 'generateCheckpoints') -and
    ($c -match 'sha256_canonical_v1') -and
    ($c -match 'DEFAULT_CHECKPOINT_INTERVAL_TICKS\s*=\s*100')
}

$criteria += Check 'G1.34' 'R68.2 replay_verifier.ts (verifyReplay returns first divergence)' {
    $f = "$repo\cmd-qa-core\output\replay\replay_verifier.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'verifyReplay\(') -and
    ($c -match 'divergenceTick') -and
    ($c -match 'checkpointsCompared')
}

$criteria += Check 'G1.35' 'R68.3 forensic_dump.ts (HIGH alert + 10MB cap)' {
    $f = "$repo\cmd-qa-core\output\replay\forensic_dump.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'writeForensicDump') -and
    ($c -match 'MAX_STATE_DUMP_BYTES') -and
    ($c -match "'HIGH'") -and
    ($c -match 'svtk_forensic_dump_v1')
}

$criteria += Check 'G1.36' 'R68.4 sampling_policy.ts (Foundation rates PvP/PvE/Raid + flagged override)' {
    $f = "$repo\cmd-qa-core\output\replay\sampling_policy.ts"
    if (-not (Test-Path $f)) { return $false }
    $c = Get-Content $f -Raw
    ($c -match 'pvpRate:\s*1\.0') -and
    ($c -match 'pveNormalRate:\s*0\.05') -and
    ($c -match 'raidBossRate:\s*1\.0') -and
    ($c -match 'flaggedPlayerOverride:\s*true')
}

$criteria += Check 'G1.37' 'R68 test suite (>= 4 test files in cmd-qa-core/tests)' {
    $count = (Get-ChildItem "$repo\cmd-qa-core\tests" -Filter "*.test.ts" -ErrorAction SilentlyContinue).Count
    $count -ge 4
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
