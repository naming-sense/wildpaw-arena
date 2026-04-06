---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "wildpaw-arena-c6c84d4dd680"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 15000
workspace:
  root: ~/code/symphony-workspaces/wildpaw-arena
hooks:
  after_create: |
    git clone --origin origin https://github.com/naming-sense/wildpaw-arena.git .
    if [ -x ./scripts/bootstrap.sh ]; then
      ./scripts/bootstrap.sh
    fi
  before_run: |
    if [ ! -d client/web/node_modules ] || [ ! -d server/gateway/node_modules ]; then
      ./scripts/bootstrap.sh
    fi
  timeout_ms: 120000
agent:
  max_concurrent_agents: 2
  max_turns: 16
  max_retry_backoff_ms: 300000
codex:
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high --model gpt-5.3-codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
---

You are working on Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
Continuation context:
- This is retry attempt #{{ attempt }}.
- Resume from the current workspace state instead of restarting from scratch.
- Do not redo already-completed investigation unless new changes require it.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Repository posture:
- This is a harness-first integrated webgame development repo.
- Read `AGENTS.md`, `STATUS.md`, `AUTOMATION_SCOPE.md`, and `ASSET_STRATEGY.md` before editing.
- Treat `docs/` as a reference archive unless the ticket explicitly points there.
- Prefer the canonical implementation surfaces: `client/web`, `server`, `shared`, and `scripts`.

Execution rules:
1. Work only in the provided repository copy.
2. Do not ask a human to perform routine follow-up. Only stop early for a true blocker such as missing auth, missing secrets, or missing required external access.
3. Stay inside the autonomy tiers defined in `AUTOMATION_SCOPE.md`. If the ticket is outside autonomous scope, produce a concrete plan/handoff and stop at `In Review`.
4. Start by reproducing the issue or validating the current behavior before changing code.
5. Make the smallest safe change set that satisfies the ticket.
6. If network/protocol changes are involved, update `shared/protocol/fbs/wildpaw_protocol.fbs` first and regenerate artifacts with `./scripts/generate_protocol.sh`.
7. Run `./scripts/check.sh` for every substantial change.
8. Run `./scripts/smoke.sh` whenever the change touches integration boundaries (`client/web`, `server`, `shared/protocol`, repo harness scripts, or CI).
9. Keep heavy binary asset churn conservative and follow `ASSET_STRATEGY.md`.
10. Final response must include: changed files, validation commands run, evidence/results, and blockers only. Do not include “next steps for user”.

State map:
- `Backlog` -> do not modify; wait.
- `Todo` -> move to `In Progress` before active implementation.
- `In Progress` -> implement and validate.
- `In Review` -> stop and wait for human review.
- `Done` -> no action.
- `Canceled` / `Duplicate` -> no action.

Definition of done:
- Required checks are green for the changed surface.
- Acceptance criteria from the ticket are explicitly addressed.
- Out-of-scope ideas become follow-up tickets instead of silent scope creep.
