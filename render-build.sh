#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# No extra steps needed if we use the environment variable PUPPETEER_CACHE_DIR in Render dashboard
# But we'll add a check here just in case.
