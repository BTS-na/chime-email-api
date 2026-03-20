#!/bin/sh
echo "=== DEBUG: node and npm versions ==="
node -v || echo "node not found"
npm -v || echo "npm not found"
echo "=== DEBUG: running app ==="
exec node index.js
