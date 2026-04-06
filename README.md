# Claude Multi-Agent Orchestrator

A self-hosted multi-agent system that automatically splits large projects into subtasks, coordinates parallel Claude Code CLI agents, and merges their outputs.

## Features

- **Parallel Agent Execution** with configurable concurrency (Semaphore + Dependency Graph)
- **Coordinator-Agent Architecture** — Coordinator plans, sub-agents execute in parallel
- **Live Dashboard** with 3 views: Cards, Timeline/Gantt, DAG Graph
- **65+ REST API Endpoints** with WebSocket + SSE dual-broadcast
- **Token Budget Tracking** with cost warnings and limits
- **Crash Recovery** with checkpoint rotation
- **Project Queue** with priorities and auto-dequeue
- **Agent Intervention** (5 types: redirect, skip, restart, inject, complete)
- **Webhook System** with HMAC-SHA256 signatures and retry
- **Config Profiles** — save, switch, import/export configurations
- **Project Snapshots** — save and restore project states
- **Undo/Redo** for config and plan changes
- **Full-text Search** across all projects
- **Merge System** with conflict detection (3 strategies: latest/largest/manual)
- **Inter-Agent Messaging** for agent-to-agent communication
- **Docker Support** with docker-compose

## Quick Start

```bash
npm install
node server.js
# Open http://localhost:3131
```

Or with auto-reload:
```bash
npm run dev
```

Or on Windows: double-click `start.bat`

## Requirements

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Architecture

```
Browser (Dashboard)
    | WebSocket + SSE + REST
    v
Express Server (server.js)
    | 65+ endpoints, auth, rate-limiting, SSE broadcast
    v
Orchestrator (orchestrator.js)
    | Parallel execution, dependency graph, merge, recovery
    v
Claude Code CLI (claude -p "...")
    v
File System (projects/{id}/agent-{n}/)
```

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3131` | Server port |
| `API_TOKEN` | – | Optional auth token (Bearer) |
| `AGENT_CONCURRENCY` | `3` | Max parallel agents |
| `MAX_AGENTS` | `10` | Max agents per project |
| `MAX_ROUNDS` | `5` | Max rounds per agent |
| `TOKEN_BUDGET` | `0` | Max token budget (0 = unlimited) |
| `MERGE_STRATEGY` | `latest` | Merge strategy (latest/largest/manual) |
| `VERIFY_AGENTS` | `false` | Verify agent outputs via Claude |

See `CLAUDE.md` for the full configuration reference.

## Tests

```bash
npm test               # 65 test suites, 681 tests
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
```

## Docker

```bash
# Build and start
npm run docker:build
npm run docker:run

# Or with docker compose
docker compose up -d

# Stop
docker compose down
```

The container reads environment variables from `.env` and mounts `projects/` as a volume for persistent agent outputs. Health checks run automatically every 30 seconds via `/health`.

## API Documentation

The server exposes 65+ endpoints. Key groups:

- **Project Control**: start, abort, resume, approve, intervene
- **Project History**: list, load, delete, changelog, diff
- **Queue**: view, reorder, clear
- **Export**: ZIP, JSON, Markdown
- **Templates**: CRUD + import/export
- **Config**: runtime config, profiles, prompts
- **Webhooks**: register, test, toggle
- **Analytics**: stats, metrics, disk usage
- **Snapshots**: create, restore, compare

Full API reference in `CLAUDE.md`.

## License

MIT
