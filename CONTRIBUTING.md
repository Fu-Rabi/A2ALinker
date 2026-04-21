# Contributing to A2A Linker

Welcome to the **A2A Linker** project! This document provides a map of the codebase, outlines the development workflow, and serves as a technical blueprint. 

Whether you are a human developer or an AI assistant (like Claude, Gemini, or GitHub Copilot) analyzing this repository, this file will help you understand the architectural boundaries, testing strategies, and project conventions.

---

## 🗺️ Codebase Map (Where things live)

The repository is structured primarily around a Node.js/TypeScript backend broker and shell-based client scripts.

### 1. Core Broker (`src/`)
This is the heart of the HTTP broker.

*   **`server.ts` & `http-server.ts`**: The main entry points. They initialize the Express app, set up rate limiting, and bind the routes. `http-server.ts` specifically handles the Express router and HTTP runtime behavior.
*   **`broker-store.ts` & Implementations**: 
    *   `broker-store.ts`: Defines the abstract `BrokerStore` interface.
    *   `memory-broker-store.ts`: The default in-memory store for local dev.
    *   `redis-broker-store.ts`: The production-ready shared state store. **If you change state management, ensure both stores stay compatible with the interface.**
*   **`broker-messages.ts` / `waiter-registry.ts` / `wake-bus.ts`**: Manage the event-driven long-polling mechanism. They handle queuing messages and waking up suspended HTTP `/wait` requests when a message arrives.
*   **`policy.ts` / `protocol.ts`**: Handles validation and the enforcement of the A2A protocol (e.g., verifying `[OVER]` boundaries).
*   **`loop-detection.ts`**: Implements safety circuit breakers to stop endless agent conversational loops.
*   **`supervisor.ts` / `supervisor-ui.ts` / `a2a-supervisor.ts`**: The TypeScript components for the local standalone supervisor, handling PTy and subprocess orchestration for local LLM CLIs.

### 2. The Agent Skill (`.agents/skills/a2alinker/`)
This folder contains the actual client logic that gets distributed to an AI agent.
*   **`SKILL.md`**: The runtime instructions an AI reads to understand how to use the A2A linker.
*   **`scripts/`**: Bash scripts (`a2a-send.sh`, `a2a-wait-message.sh`, `a2a-loop.sh`) used by agents to communicate via plain HTTP instead of complex SDKs. 
*   **`settings/`**: Configurations mapped to specific terminal-native AI clients (Claude, Codex, Gemini).

### 3. Tests (`tests/`)
All unit and integration testing logic. We use **Jest**.

---

## 🛠️ Development Setup & Commands

### Prerequisites
*   Node.js (v18+ recommended)
*   Redis (Required if testing production shapes)

### Quick Start
```bash
# 1. Install dependencies
npm install

# 2. Run the server in development mode
npm run dev

# 3. Build for production
npm run build
```

### Running Tests
Testing is a critical part of the contribution workflow. A2A Linker has multiple test suites.

```bash
# Run the Jest test suite (Unit & Integration tests)
npm test

# Run the HTTP End-to-End Bash test
npm run test:http-e2e
```

**Testing Rules:**
1.  **Do not break the interface:** If you add a feature that modifies how state is stored, you must update and test *both* `memory-broker-store.ts` and `redis-broker-store.ts`.
2.  **Add a test:** All new HTTP routes, protocol changes, or supervisor behaviors must have corresponding Jest tests added to the `tests/` directory.

---

## 🏗️ Architectural Guidelines & Boundaries

If you are expanding A2A Linker, please adhere to these core philosophies:

1.  **Zero Durable State (Privacy First):** The broker must never durably log or save the content of messages. Do not add Postgres/MySQL databases for message history. State should strictly use memory or TTL-bound Redis keys.
2.  **HTTP-First, No WebSockets:** The design intentionally uses long-polling HTTP (via `/wait`) instead of WebSockets. This makes it trivial for simple CLI scripts to interact using `curl` without requiring persistent socket libraries. Do not convert the core transport to WebSockets.
3.  **Terminal-Agnostic Clients:** Scripts in `.agents/skills/a2alinker/scripts/` must prioritize pure `bash` and standard tools (`curl`, `grep`). Avoid introducing dependencies on Python, Node, or specific OS packages inside the agent clients.
4.  **Graceful Loop Breaking:** Autonomous agents easily get stuck in loops (e.g., "Thank you!" -> "You're welcome!" -> "Anytime!"). Any modifications to message parsing must preserve the `loop-detection.ts` safeguards.

---

## 🤖 Notes for AI Assistants (LLMs)

If an AI (like yourself) is reading this to assist in coding:
1.  **Do not use mock data in production paths.** 
2.  **Acknowledge the `[OVER]` / `[STANDBY]` protocol.** If you change how messages are queued, ensure you don't accidentally split the walkie-talkie protocol tokens across chunks.
3.  **Prioritize Security:** Validate all HTTP inputs in `src/http-server.ts`. Assume `tok_` identifiers can be forged if not validated against the `BrokerStore`.
4.  **Testing First:** If instructed to fix a bug, please run `npm test` after your changes before considering the task complete.

---

## 📝 License Reminder
A2A Linker is licensed under the **Apache License 2.0**. Ensure any dependencies you introduce are compatible with this license.

Project identity is handled separately. If you are working on branding, naming, or public presentation, follow [TRADEMARKS.md](./TRADEMARKS.md).
