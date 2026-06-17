---
description: Global repository guidance for docs-first development with scoped AGENTS handoff into subprojects
---

# Repository Copilot Instructions

## Root baseline and scoped instructions

* This root `AGENTS.md` is the default baseline for work started from the repository root.
* When work primarily targets a scoped area, proactively read that area's local `AGENTS.md` before planning or editing.
* Apply the same rule to other scoped areas when a local `AGENTS.md` exists, such as `docs/` or `test/`.

## Docs-first design baseline

* Treat `docs/` as the repository's canonical baseline for concepts, design intent, architecture, ownership boundaries, and product direction.
* Before changing APIs, workflows, data models, profile/config ownership, sync boundaries, or user-visible behavior, review the most relevant documents in `docs/` first.
* Optimize changes toward the intended design captured in `docs/`, not toward preserving incidental behavior in older code paths.
* If implementation and documentation diverge, prefer aligning the implementation to the documented direction first.
* When the design has intentionally evolved, update the relevant docs in the same change rather than letting code become the only place where the new truth exists.

## Handling stale code and tests

* Do not preserve obsolete behavior through downward-compatibility shims just because older code, tests, or notes still reference it.
* If `docs/` represents the current intended direction and older tests or code conflict with it, update, remove, or rewrite the stale artifacts to match the design.
* Prefer deleting tests that lock in abandoned behavior over adding compatibility logic only to keep them green.
* Prefer a small number of explicit, well-owned truths over layered compatibility paths that increase technical debt and maintenance burden.
* Only keep compatibility behavior when there is an explicit migration, rollout, or user-facing requirement that justifies the added complexity.
