---
name: agents-telemetry-release
description: Release a new version of agents-telemetry. Use when preparing, validating, committing, tagging, pushing, or publishing a GitHub release for this repository's Pi, Claude Code, and OpenCode integrations.
---

# agents-telemetry release

Use this workflow only from the repository root. It handles a release, not an unreviewed feature change: finish and review the intended change before starting.

## Safety rules

- Do not publish merely because a version was mentioned. Obtain an explicit confirmation immediately before the commit/tag/push/GitHub-release step.
- Never stage blindly with `git add -A`. Stage only the reviewed release files.
- Do not put Markdown backticks in a shell command enclosed in double quotes; the shell treats them as command substitutions. Use a quoted heredoc or `--notes-file` for release notes.
- Stop on unexpected changes, a non-clean starting tree, a failing check, a non-`main` branch, a remote that is ahead, an existing release tag, or unauthenticated GitHub CLI. Explain the issue and ask how to proceed.

## 1. Preflight

Confirm the checkout and release state:

```bash
[ "$(git branch --show-current)" = main ]
git status --short
git fetch origin --tags
git status -sb
git tag --sort=-v:refname | head -10
gh auth status
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "Tag v$VERSION already exists" >&2; exit 1
fi
if gh release view "v$VERSION" --json url >/dev/null 2>&1; then
  echo "GitHub release v$VERSION already exists" >&2; exit 1
fi
```

`VERSION` is the target bare semver (for example, `0.7.2`). Determine it with the user; use a patch version for a backwards-compatible fix. The working tree must start clean, and `main` must not be behind `origin/main`.

If the exact target tag or GitHub release already exists, stop rather than overwriting it.

## 2. Bump every shipped version

Use npm to update the package manifest and lockfile without creating a tag:

```bash
npm version "$VERSION" --no-git-tag-version
```

Then update these version constants/manifests to the same value:

- `pi/src/index.ts` — `VERSION`
- `opencode/src/index.ts` — `VERSION`
- `claude/src/version.ts` — `VERSION`
- `claude/.claude-plugin/plugin.json` — `version`

The Claude plugin is version-pinned. Its manifest and committed bundle must be included even when the functional fix only affects another emitter.

## 3. Build and validate

Rebuild the committed Claude artifact, then run the full release checks:

```bash
npm run build:claude
npm run typecheck
npm test
claude plugin validate .
claude plugin validate ./claude
```

If the change affects installation or dependency metadata, also test the supported installer scenario. Restore the normal development dependency tree afterwards:

```bash
npx --yes npm@<npm-version-to-test> install --omit=dev --ignore-scripts --package-lock=false
npm ci
```

Review the exact diff and status. `claude/dist/bridge.cjs` is generated and committed. Some bundled dependencies contain tabbed template strings, so check source-file whitespace while excluding that artifact:

```bash
git diff --check -- . ':(exclude)claude/dist/bridge.cjs'
git diff --stat
git diff -- package.json package-lock.json pi/src/index.ts opencode/src/index.ts claude/src/version.ts claude/.claude-plugin/plugin.json
git status --short
```

## 4. Confirm publication

Summarize the version, release notes, changed files, and successful checks. Ask the user to explicitly confirm the single publication batch: commit, annotated tag, push, and GitHub release. Do not run the commands below without that confirmation.

## 5. Publish after confirmation

Stage only the reviewed files. Include any other explicitly reviewed functional files as needed:

```bash
git add package.json package-lock.json \
  pi/src/index.ts opencode/src/index.ts \
  claude/src/version.ts claude/.claude-plugin/plugin.json claude/dist/bridge.cjs
git diff --cached --check -- . ':(exclude)claude/dist/bridge.cjs'
git diff --cached --stat
git commit -m "release: $VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
gh release create "v$VERSION" --title "v$VERSION" --generate-notes
```

For custom release notes, write them to a file using a **single-quoted** heredoc and pass it with `--notes-file`; do not interpolate Markdown into a double-quoted shell argument:

```bash
cat > /tmp/agents-telemetry-release-notes.md <<'EOF'
## Fixed
- Describe the user-visible fix.
EOF
gh release create "v$VERSION" --title "v$VERSION" --notes-file /tmp/agents-telemetry-release-notes.md
```

## 6. Verify publication

```bash
git status --short
git log -1 --oneline --decorate
gh release view "v$VERSION" --json url,name,tagName,isDraft,isPrerelease
```

Report the release URL, commit SHA, tag, and checks run.
