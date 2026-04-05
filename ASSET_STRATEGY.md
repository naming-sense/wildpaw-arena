# ASSET_STRATEGY.md

This repository is primarily an implementation repo, not a long-term dumping ground for every binary asset iteration.

## Goals

- keep clone/pull times reasonable
- keep diffs reviewable
- separate runtime-ready assets from source/working assets
- reduce accidental growth from duplicated exports and backups
- prepare the repo for Git LFS without forcing a history rewrite right now

## Asset classes

### 1) Runtime-ready web assets
These are optimized assets actually consumed by the running client.

Keep in normal Git when they are reasonably sized and intentionally shipped:
- small/medium UI images
- optimized JSON/text configs
- runtime-ready web assets that are actively used by the client

Primary location:
- `client/web/public/assets/`

Rule:
- only keep the current, intended runtime payloads here
- avoid storing many duplicate experiment variants in the main runtime path

### 2) Heavy binary/source assets
These should move toward Git LFS by default.

Examples:
- `.glb`
- `.fbx`
- `.blend`
- `.psd`
- long-form audio/video captures
- large archive files used as canonical source payloads

Rule:
- new or newly-touched heavy binary assets should use Git LFS going forward
- do not rewrite repo history automatically; treat that as a separate, human-approved migration step

### 3) Generated/backup/intermediate assets
These are not canonical source of truth.

Examples:
- backup exports
- one-off test renders
- temporary variants
- local experiment files

Rule:
- do not let these become the default storage pattern in the main repo
- prefer local scratch space, artifact storage, or an archive area with explicit intent

## Immediate repo policy

### Keep in main Git
- source code
- YAML/JSON/text specs
- protocol definitions
- build/test/harness scripts
- small docs and reference material
- intentionally shipped small UI assets

### Use Git LFS going forward
- canonical heavy binary 3D/source assets
- large binary media used as real project assets

### Avoid tracking by default
- ad-hoc backups
- duplicated export variants with only naming differences
- temporary migration artifacts

## Near-term migration plan

1. Add `.gitattributes` rules for heavy binary formats.
2. Start using LFS for new or newly-updated heavy binary assets.
3. Keep existing history as-is for now.
4. If repo size or asset churn becomes painful, evaluate one of:
   - `git lfs migrate import` with explicit sign-off
   - a separate `wildpaw-arena-assets` repo
   - external asset storage for source/master payloads

## Triggers for a stronger migration

Escalate to a dedicated asset migration when one or more becomes true:
- clone/pull time becomes a repeated complaint
- CI/network bandwidth becomes a real cost/problem
- large asset churn becomes common
- source/master art assets start to dominate repo size
- review quality drops because binary changes overwhelm code changes

## Human approval required

These actions require explicit human sign-off:
- repo history rewrite for LFS migration
- deleting or mass-moving large tracked assets
- splitting assets into a separate repository

## Practical guidance for agents

- prefer touching code, config, and runtime-ready assets only when the ticket demands it
- if a task would cause large binary churn, stop and summarize the recommended path
- when in doubt, preserve existing assets and propose the migration rather than forcing it
