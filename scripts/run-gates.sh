#!/bin/bash
# Release-gate runner.
#
# Gates MUST run strictly sequentially. The browser suites all sign in as the
# same probe account and share the same local rate-limit counters, so two of
# them running at once consume each other's one-time codes and fail in ways that
# look like product regressions. This runner enforces serialisation with a lock
# file instead of trusting whoever invokes it to remember.
#
# Usage: bash scripts/run-gates.sh [gate ...]      (no args = all gates)
set -uo pipefail
cd /home/user/webapp

LOCK=/tmp/artifactry-gates.lock
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "ABORT: another gate run is already in progress (lock: $LOCK)" >&2
  exit 3
fi

ALL=(build check-imports check-undefined test-preview test-preview-security test-preview-ui test-authz test-index-sync test-semantic test-extract test-autotag test-mcp-jobs test-tag-decisions test-oauth)
GATES=("$@")
[ ${#GATES[@]} -eq 0 ] && GATES=("${ALL[@]}")

pass=0; fail=0; failed_gates=()

run_gate() {
  local g="$1"
  echo "───────────────────────────────────────────────────────────"
  echo "  GATE: ${g}"
  echo "───────────────────────────────────────────────────────────"
  local log="/tmp/gate-${g}.log"
  local rc=0
  case "$g" in
    build)                 npm run build && npm run build:preview ;;
    check-imports)         node scripts/check-imports.mjs ;;
    check-undefined)       node scripts/check-undefined.mjs ;;
    test-preview)          node scripts/test-preview.mjs ;;
    test-preview-security) node scripts/test-preview-security.mjs ;;
    test-preview-ui)       node scripts/test-preview-ui.mjs ;;
    test-authz)            node scripts/test-authz.mjs ;;
    test-index-sync)       node scripts/test-index-sync.mjs ;;
    test-semantic)         node scripts/test-semantic.mjs ;;
    test-extract)          node scripts/test-extract.mjs ;;
    # Headless: the tagging suggester is pure, so this needs no browser and no
    # database. It also checks the configured model against the live Workers AI
    # catalog, which is what catches a deprecation before production does.
    test-autotag)          node scripts/test-autotag.mjs ;;
    # Headless: real service modules against a real SQLite built from the actual
    # migration files. No browser, so it needs no probe account and does not
    # contend with the serialised browser suites for one-time codes.
    test-mcp-jobs)         node scripts/test-mcp-jobs.mjs ;;
    # Headless: real service modules and the real MCP transport against a real
    # SQLite built from the actual migrations. Covers the tag decisions on BOTH
    # surfaces, because the failure mode is one surface enforcing a rule the
    # other does not.
    test-tag-decisions)    node scripts/test-tag-decisions.mjs ;;
    # Headless: the real app bundle through app.fetch against a real SQLite
    # from the migrations. Walks the full OAuth connector sign-in (discovery,
    # registration, consent, PKCE, refresh, disconnect) and every save source.
    test-oauth)            node scripts/test-oauth.mjs ;;
    *) echo "unknown gate: $g" >&2; return 1 ;;
  esac > "$log" 2>&1
  rc=$?

  # Show the lines that carry the verdict, not the whole transcript.
  grep -E "passed|failed|PASSED|FAILED|ALL |✓ built|gzip:|No project symbols|All relative imports|✗|✘|ERROR|Error:" "$log" | tail -12 | sed 's/^/    /'
  if [ "$rc" -eq 0 ]; then
    echo "    => PASS"
    pass=$((pass + 1))
  else
    echo "    => FAIL (exit ${rc}); full log: ${log}"
    fail=$((fail + 1)); failed_gates+=("$g")
  fi
  echo
}

for g in "${GATES[@]}"; do
  run_gate "$g"
done

echo "═══════════════════════════════════════════════════════════"
echo "  GATE SUMMARY: ${pass} passed, ${fail} failed"
if [ "$fail" -gt 0 ]; then
  echo "  FAILED: ${failed_gates[*]}"
  exit 1
fi
echo "  ALL GATES PASSED"
