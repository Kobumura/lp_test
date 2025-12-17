# CLAUDE.md - LittlePipes (lp_test)

> **Shared context**: See `littletalks-docs/CLAUDE.md` for Jira setup, screenshot locations, commit guidelines, and cross-project paths.
> **Path**: `C:\Users\dorot\AndroidStudioProjects\littletalks-docs`

## Project Overview

LittlePipes is the CI/CD platform for automated mobile app builds and deployments.

- **GitHub Repo**: `Kobumura/lp_test` (public for unlimited Actions minutes)
- **Jira Project**: LP
- **Purpose**: App-agnostic build system - "throwing at LittlePipes" = triggering a build

## Architecture

- **Public/Private Repo Pattern**: Triggers from private repo, executes in public repo (95% cost savings)
- **Mixed Runner Strategy**: BuildJet for Android (~8 min), GitHub macos for iOS (~20 min)
- **Fastlane**: Handles signing, building, and deployment to stores

## Key Workflows

| Workflow | Purpose |
|----------|---------|
| `build-on-dispatch.yaml` | Android builds via repository dispatch |
| `ios-build-dispatch.yaml` | iOS builds via repository dispatch |
| `test-appstore-query.yaml` | App Store Connect API testing |

## Documentation

Primary docs live in `littletalks-mobile/docs/littlepipes/`:
- `LittlePipes Project Overview & Context.md` - Architecture, costs, status
- `LittlePipes Version Management.md` - Version strategies
- `Automated Development Workflow Plan.md` - Jira integration workflow

## Session Handoffs

**Location**: Create in `littletalks-mobile/docs/session_handoffs/` (LittlePipes work is usually in context of mobile app)
**Template**: See `littletalks-docs/shared/session-handoff-template.md`
