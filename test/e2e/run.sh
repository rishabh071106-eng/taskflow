#!/bin/bash
# The end-to-end suites (real server, real browser at phone size): node test/e2e/run.sh from the repo root.
# Needs npm ci and Playwright's Chromium. Each suite prints "<name>: N passed, M failed"; exit 1 if any failed.
cd "$(dirname "$0")/../.." || exit 1
rc=0; for t in smoke bookvoice books; do node test/e2e/$t.mjs > /tmp/brodoit-e2e-$t.log 2>&1 || rc=1; grep -E "FAIL" /tmp/brodoit-e2e-$t.log | head -5; tail -1 /tmp/brodoit-e2e-$t.log; done; exit $rc
