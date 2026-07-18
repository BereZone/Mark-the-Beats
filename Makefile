.PHONY: help bump tag tag-delete check-versions

SEMVER_RE := ^[0-9]+\.[0-9]+\.[0-9]+$$

help:
	@echo "Usage:"
	@echo "  make bump VERSION=1.2.3   Bump version in package.json and manifest.json"
	@echo "  make tag  VERSION=1.2.3   Create an annotated git tag v1.2.3"
	@echo "  make tag-delete VERSION=1.2.3  Delete local (and optionally remote) tag"
	@echo "  make check-versions       Check package.json and manifest.json are in sync"

# ── check-versions ────────────────────────────────────────────────────────────
check-versions:
	@PKG=$$(node -p "require('./package.json').version"); \
	 MAN=$$(node -p "require('./manifest.json').version"); \
	 if [ "$$PKG" != "$$MAN" ]; then \
	   echo "ERROR: version mismatch — package.json=$$PKG manifest.json=$$MAN"; \
	   exit 1; \
	 fi; \
	 echo "Versions in sync: $$PKG"

# ── bump ──────────────────────────────────────────────────────────────────────
bump:
ifndef VERSION
	$(error VERSION is required: make bump VERSION=1.2.3)
endif
	@echo "$(VERSION)" | grep -qE '$(SEMVER_RE)' || \
	  { echo "ERROR: '$(VERSION)' is not valid semver (expected X.Y.Z, no leading 'v')"; exit 1; }
	@CURRENT=$$(node -p "require('./package.json').version"); \
	 echo "Bumping from $$CURRENT → $(VERSION)"; \
	 read -p "Confirm? [y/N] " yn; \
	 [ "$$yn" = "y" ] || { echo "Aborted."; exit 1; }
	@# Detect drift — only update files that don't already have the target version
	@PKG_VER=$$(node -p "require('./package.json').version"); \
	 if [ "$$PKG_VER" != "$(VERSION)" ]; then \
	   node -e " \
	     const fs = require('fs'); \
	     const p = JSON.parse(fs.readFileSync('package.json')); \
	     p.version = '$(VERSION)'; \
	     fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n'); \
	   "; \
	   echo "  Updated package.json → $(VERSION)"; \
	 else \
	   echo "  package.json already at $(VERSION) — skipped"; \
	 fi
	@MAN_VER=$$(node -p "require('./manifest.json').version"); \
	 if [ "$$MAN_VER" != "$(VERSION)" ]; then \
	   node -e " \
	     const fs = require('fs'); \
	     const m = JSON.parse(fs.readFileSync('manifest.json')); \
	     m.version = '$(VERSION)'; \
	     fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n'); \
	   "; \
	   echo "  Updated manifest.json → $(VERSION)"; \
	 else \
	   echo "  manifest.json already at $(VERSION) — skipped"; \
	 fi
	@echo "Done. Remember to update CHANGELOG.md and commit before tagging."

# ── tag ───────────────────────────────────────────────────────────────────────
tag:
ifndef VERSION
	$(error VERSION is required: make tag VERSION=1.2.3)
endif
	@echo "$(VERSION)" | grep -qE '$(SEMVER_RE)' || \
	  { echo "ERROR: '$(VERSION)' is not valid semver (expected X.Y.Z, no leading 'v')"; exit 1; }
	@echo "$(VERSION)" | grep -qE '^v' && \
	  { echo "ERROR: do not include a leading 'v' — the Makefile adds it automatically"; exit 1; } || true
	@$(MAKE) --no-print-directory check-versions
	@PKG_VER=$$(node -p "require('./package.json').version"); \
	 if [ "$$PKG_VER" != "$(VERSION)" ]; then \
	   echo "ERROR: package.json version ($$PKG_VER) does not match requested tag ($(VERSION))"; \
	   echo "Run 'make bump VERSION=$(VERSION)' first."; \
	   exit 1; \
	 fi
	@git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	@echo "Created annotated tag v$(VERSION)."
	@echo "Push with:  git push --follow-tags"

# ── tag-delete ────────────────────────────────────────────────────────────────
tag-delete:
ifndef VERSION
	$(error VERSION is required: make tag-delete VERSION=1.2.3)
endif
	@git tag | grep -qx "v$(VERSION)" || \
	  { echo "ERROR: local tag v$(VERSION) does not exist"; exit 1; }
	@read -p "Delete local tag v$(VERSION)? [y/N] " yn; \
	 [ "$$yn" = "y" ] || { echo "Aborted."; exit 1; }
	@git tag -d "v$(VERSION)"
	@echo "Local tag v$(VERSION) deleted."
	@read -p "Also delete from remote 'origin'? [y/N] " yn2; \
	 if [ "$$yn2" = "y" ]; then \
	   git push origin ":refs/tags/v$(VERSION)"; \
	   echo "Remote tag v$(VERSION) deleted."; \
	 else \
	   echo "Remote tag left untouched."; \
	 fi
