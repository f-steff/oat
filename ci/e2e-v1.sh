#!/usr/bin/env bash
# Real opencode v1 end-to-end: install v1, build, run the two-server e2e.
set -euo pipefail

# Pin the v1 major so a future v2 release of the package cannot drift this job.
npm install --global "opencode-ai@1"
opencode --version
npm run build
node scripts/e2e.mjs
