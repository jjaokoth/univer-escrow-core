#!/bin/bash
set -e
echo "=================================================================="
echo "LAUNCHING SYSTEM SYNCHRONIZATION RUNBOOK"
echo "=================================================================="

if [ -z "$GH_TOKEN" ]; then
    echo "[ERROR] Missing GH_TOKEN environment variable."
    exit 1
fi

echo "[INFO] Running core structural checks..."
bash scripts/verify-repo-state.sh

echo "[INFO] Staging architectural profile artifacts..."
git add README.md scripts/deploy-and-initialize.sh .github/workflows/project-launch.yml

echo "[INFO] Committing local configurations..."
git commit -m "chore(release): integrate deployment scripts and production documentation" --allow-empty

echo "[INFO] Synchronizing tracking matrices upstream..."
git remote set-url origin "https://${GH_TOKEN}@[github.com/jjaokoth/univer-escrow-core.git](https://github.com/jjaokoth/univer-escrow-core.git)"
git push origin master --force

echo "[SUCCESS] Main repository alignment completed."
