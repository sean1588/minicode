# Product Requirements Document: Custom Coding Agent

## 1. Overview

A custom AI coding agent that can autonomously navigate, understand, and modify codebases through an iterative tool-use loop. The agent receives high-level instructions from a user, decomposes them into steps, uses file/shell tools to explore and edit code, and returns completed results.

## 2. Problem Statement

Working with large codebases requires significant context-switching: reading files, searching for patterns, understanding dependencies, making edits, running tests. An AI coding agent can handle the mechanical parts of this workflow — navigating, reading, editing, and verifying — while the human focuses on intent and review.

## 3. Target Users

- Developers who want an AI pair-programmer they fully control
- Learners exploring agentic AI patterns hands-on
- Teams wanting a self-hosted coding assistant (no vendor lock-in)

## 4. Goals (MVP)

- **G1:** Interactive CLI agent that accepts natural language coding tasks
- **G2:** Agent can read, search, list, write, and edit files in a target codebase
- **G3:** Agent can run shell commands (with safety guardrails)
- **G4:** Multi-turn conversation with session history
- **G5:** Clear termination policy — agent knows when it's done

## 5. Non-Goals (MVP)

- Web UI or chat platform integrations
- Subagent spawning / Kubernetes orchestration
- Vector/embedding-based memory or RAG
- Plugin/extension system
- Multi-user or multi-tenant support
- Autonomous long-running background tasks

## 6. User Stories

### US-1: Ask the agent to make a code change
> As a developer, I can describe a code change in natural language and the agent will find the relevant files, make the edits, and report what it did.

### US-2: Ask the agent to explain code
> As a developer, I can ask "how does X work?" and the agent will navigate the codebase, read relevant files, and explain the answer.

### US-3: Ask the agent to run and verify
> As a developer, I can ask the agent to run tests or lint after making changes, and it will report pass/fail status.

### US-4: Multi-turn refinement
> As a developer, I can have a back-and-forth conversation where I refine the agent's work across multiple turns without losing context.

### US-5: Safety and control
> As a developer, I can trust that the agent won't run destructive commands or modify files outside the target workspace without confirmation.

## 7. Functional Requirements

### 7.1 Core Agent Loop
- The agent operates in a loop: receive input → reason → call tools (or respond) → repeat
- The loop terminates when the model returns a final text response with no tool calls, or when a guardrail fires (max steps, timeout)
- Each iteration appends tool calls and results to session history

### 7.2 Tool System
Minimum tool set for MVP:

| Tool | Purpose |
|------|---------|
| `read_file` | Read contents of a file (with optional line range) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Search-and-replace edit within a file |
| `search` | Grep/ripgrep pattern search across files |
| `list_files` | List directory contents |
| `run_command` | Execute a shell command (sandboxed) |

### 7.3 System Prompt
- Tells the agent its identity, available tools, and usage guidelines
- Includes workspace context (current directory, project type if detectable)
- Defines termination behavior (when to stop, when to ask for clarification)

### 7.4 Session Management
- In-memory session history (array of messages) for MVP
- History includes: user messages, assistant messages, tool calls, tool results
- Token-aware trimming when history exceeds model context window

### 7.5 Safety Guardrails
- Max iterations per turn (e.g., 25 steps)
- Command allowlist/denylist for shell execution
- File path restrictions (stay within workspace)
- Timeout per tool execution
- Confirmation prompts for destructive operations (optional, can be toggled)

## 8. Non-Functional Requirements

- **Latency:** Streaming responses for real-time feedback
- **Portability:** Works on Linux, macOS, WSL
- **Model flexibility:** Swap between Claude, GPT-4, local models (Ollama) via config
- **Simplicity:** Single entry point, minimal dependencies, easy to understand and hack on

## 9. Success Criteria (MVP)

- [ ] Agent can read a file and answer questions about its contents
- [ ] Agent can make a multi-file edit based on a natural language request
- [ ] Agent can run a test suite and report results
- [ ] Conversation persists across multiple turns in a session
- [ ] Agent stops cleanly when task is complete or limit is reached
- [ ] No unintended file modifications outside workspace

## 10. Future Enhancements (Post-MVP)

| Phase | Feature |
|-------|---------|
| **v0.2** | File-based session persistence (SQLite) |
| **v0.2** | Token counting and smart history trimming |
| **v0.3** | Vector memory / codebase indexing (sqlite-vec or ChromaDB) |
| **v0.3** | Semantic code search via embeddings |
| **v0.4** | Subagent spawning (manager + worker pattern) |
| **v0.4** | Model tiering (expensive model for planning, cheap for execution) |
| **v0.5** | Kubernetes job-based subagent execution |
| **v0.5** | Message bus integration (NATS/Redis Streams) |
| **v1.0** | Web UI, API server, multi-user support |
