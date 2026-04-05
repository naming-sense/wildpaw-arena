# AUTOMATION_SCOPE.md

This file defines what Wildpaw Arena agents may do autonomously, what requires human review, and what stays human-owned.

## Purpose

Use this as the autonomy boundary for:
- Symphony / `WORKFLOW.md`
- Codex or other coding agents
- repo-local harness automation

## Tier A — autonomous end-to-end

Agents may implement these without prior human approval as long as they stay scoped, validate changes, and stop at `Human Review` when appropriate.

Allowed examples:
- deterministic bug fixes in `client/web`, `server`, or `shared`
- protocol/schema changes with matching codegen and validation
- build/test/smoke/CI improvements
- harness improvements (`AGENTS.md`, `STATUS.md`, `WORKFLOW.md`, scripts, CI)
- documentation that is tightly coupled to implementation
- small refactors that do not change product intent
- observability, logging, metrics, and validation tooling
- compatibility fixes for repo tooling or generated code

Required behavior:
- reproduce or confirm current behavior first
- keep diffs small and inspectable
- run `./scripts/check.sh`
- run `./scripts/smoke.sh` if integration boundaries are touched

## Tier B — autonomous implementation, human review required before landing

Agents may prepare these, but they should stop at `Human Review` with a clear summary and risk note.

Examples:
- multi-surface refactors across `client/web`, `server`, and `shared`
- non-trivial networking changes that alter behavior or compatibility
- asset layout / repo structure changes
- new developer workflows or repo policy changes with team impact
- performance work that changes runtime tradeoffs
- large gameplay parameter adjustments when the target behavior is clearly specified

## Tier C — plan / prototype / scaffold only

Agents may prepare a plan, spike, prototype, or scaffolding, but should not finalize product decisions autonomously.

Examples:
- new hero kits, skill concepts, or class identity changes
- new map concepts or major level-design direction changes
- monetization / progression / reward-loop redesigns
- large UX flow redesigns
- major architecture migrations
- repo history rewrite plans for asset migration
- “split this into multiple repos” proposals

Deliverables at this tier:
- concrete plan
- scope/risk summary
- prototype or scaffolding only if explicitly useful
- clear handoff note for human review

## Tier D — human-owned / do not automate

Agents should not perform these autonomously.

Examples:
- changing core game vision, fantasy, or product direction
- final balance calls based on feel rather than explicit acceptance criteria
- economy / BM / live-ops decisions
- destructive history rewrites (`git filter-repo`, `git lfs migrate import`, force-push rewrite)
- deleting large content sets without explicit human approval
- production secrets, infra credentials, or security-sensitive external actions
- legal/compliance statements or public-facing commitments

## Default handoff policy

- `Todo` -> move to `In Progress` before active work.
- Tier A -> complete implementation and validation, then stop at workflow-defined handoff.
- Tier B -> implement, validate, summarize risk, and stop at `Human Review`.
- Tier C -> plan/prototype only, then stop at `Human Review`.
- Tier D -> do not act; return a concrete recommendation or request explicit human direction.

## Evidence required in handoff

Every autonomous run should leave:
- files changed
- validation commands run
- result/evidence summary
- explicit blocker/risk note if relevant

## Out-of-scope discoveries

If useful but out-of-scope work is discovered during execution:
- do not silently expand scope
- create or recommend a follow-up ticket
- keep the original task tightly bounded
