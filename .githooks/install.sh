#!/usr/bin/env bash
# Setup repo-tracked hooks. Run once per clone.
set -eu
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true
echo "OK: core.hooksPath -> .githooks"
echo "Policy: cmd-lead/POLICY_NO_DESKTOP.md"
