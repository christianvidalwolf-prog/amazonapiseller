# Project Claude Code config

Agents, commands, skills and rules vendored from
[WorldFlowAI/everything-claude-code](https://github.com/WorldFlowAI/everything-claude-code)
(commit `432485b`, MIT, original author Affaan Mustafa). They live in the repo so
they load on any machine that clones it — no per-PC install.

Changes from upstream:

- `/code-review` and `/plan` are named `/ecc-code-review` and `/ecc-plan`, and the
  `security-review` skill is `security-review-checklist`, so they don't shadow
  Claude Code's built-ins of the same name.
- Hooks (`hooks/hooks.json`, `scripts/`) are not installed: they block
  `npm run dev` outside tmux, block writing `.md` files and run Prettier on every
  edit, which clashes with this repo's workflow.
- Rules `testing.md`, `git-workflow.md`, `hooks.md` and `performance.md` are left
  out (mandatory TDD / 80% coverage, references to the hooks above, outdated
  model guidance). `CLAUDE.md` stays the source of truth for project conventions.
- Not included: `continuous-learning` and `strategic-compact` skills (hook-driven),
  `/setup-pm`, `mcp-configs/`, `contexts/`, `examples/`.
