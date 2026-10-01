#!/usr/bin/env bash
# Real opencode v2 end-to-end: install v2, build, run the v2 e2e.
set -euo pipefail

# Pin the v2 major so a future v3 release of the package cannot drift this job.
npm install --global "@opencode/cli@2"
opencode --version
npm run build
node scripts/e2e-v2.mjs
