#!/usr/bin/env bash
# exit on error
set -o errexit

# Install project dependencies
npm install

# Install the Chrome browser for Puppeteer
# This is needed because Render's default environment doesn't include it.
echo "⏳ Installing Chrome browser..."
npx puppeteer browsers install chrome
echo "✅ Chrome installation complete!"
