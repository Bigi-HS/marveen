# Makefile -- convenience wrappers for the most frequent operator commands.
#
# Default target: `make` prints help and exits.
# Destructive/deploy targets (deploy, flip) are NOT part of the default target
# and must be invoked explicitly.
#
# Targets:
#   help          -- this message (default)
#   preflight     -- pre-GO gate only (backup + delta/risk check); no changes to the live system
#   deploy        -- full Genesis dashboard deploy (Requires Genesis-GO; card dc39ba0f)
#   deploy-dryrun -- steps 0-1 only: hold+delta check, no changes

SHELL := /bin/bash
.DEFAULT_GOAL := help

REPO := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))

.PHONY: help preflight deploy deploy-dryrun

help:
	@echo ""
	@echo "NoA fleet operator commands"
	@echo ""
	@echo "  make preflight      Run pre-GO gate (rollback point + preflight checks, no live changes)"
	@echo "  make deploy         Full dashboard deploy -- requires Genesis-GO first"
	@echo "  make deploy-dryrun  Hold+delta check only; no build or restart"
	@echo ""
	@echo "Targets that are NOT here on purpose:"
	@echo "  dashboard-new ROOT FLIP (card 2d70c06e) -- invoke scripts/flip.sh directly when ready"
	@echo ""

preflight:
	@bash $(REPO)scripts/deploy-backup.sh

deploy:
	@bash $(REPO)scripts/deploy.sh

deploy-dryrun:
	@bash $(REPO)scripts/deploy.sh --dry-run
