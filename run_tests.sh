#!/usr/bin/env bash
# FormCoach AI — run every test suite, one by one.
#   ./run_tests.sh
set -u
cd "$(dirname "$0")"

PASS=0; FAIL=0
run() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✅ $name"
    PASS=$((PASS + 1))
  else
    echo "❌ $name"
    FAIL=$((FAIL + 1))
  fi
}

echo "───────── FormCoach AI test battery ─────────"
run "Biomechanics engine (reps, scoring, blip/hold guards, jacks, high knees)" \
    node frontend/tests/engine.test.mjs
run "Movement Twin (baseline comparison, measured deviations)" \
    node frontend/tests/twin.test.mjs
run "Landmark smoothing filter (jitter reduction, visibility passthrough)" \
    node frontend/tests/smooth.test.mjs
run "Zero-knowledge auth (encryption at rest, user isolation, bad passwords)" \
    node frontend/tests/auth.test.mjs
run "Backend API (4 agents, persistence, coach key, validation) — pytest" \
    python3 -m pytest backend/tests -q
run "JS syntax — every frontend module" \
    bash -c 'for f in frontend/src/app.js frontend/src/engine/*.js frontend/src/services/*.js frontend/src/ui/*.js frontend/sw.js; do node --input-type=module --check < "$f" || exit 1; done'
run "manifest.json is valid" \
    python3 -c "import json; json.load(open('frontend/manifest.json'))"

echo "──────────────────────────────────────────────"
echo "Suites passed: $PASS · failed: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN — safe to demo." || echo "FIX FAILURES BEFORE DEMO."
exit "$FAIL"
