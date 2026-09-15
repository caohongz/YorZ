<div align="center">

# YorZ · Step Into the New Era of AI Coding

### Coding Made Simple and Comfortable

_A minimal, zero-barrier interaction design with mobile-first best practices — you can even "write" code lying down_

### Unleash Your Agents

_Let Claude / Codex run 10 tasks at once, with zero interference_

### A Picture Is Worth a Thousand Words

_Decide from diagrams, and free developers from wading through docs and code_

---

**English** · [中文](./README_CN.md) · [📖 User Guide](./docs/User-Guide.md)

</div>

![preview](./docs/preview.png)

## What Makes YorZ (Youzi) Different

- Minimal interaction design with a zero-barrier learning curve — friendly to coding beginners
- Mobile-first best practices — you can even "write" code lying down
- Built-in spec-driven development workflow that tames large projects and complex requirements
- Concurrent tasks that run in isolation, squeezing every drop out of your Agents
- Rich technical diagrams that elevate docs and code into insight for faster understanding and sharper decisions
- Compatible with mainstream Agents, with seamless multi-Agent switching

## Installation

Requires Node.js >= 22.19.0 (the floor comes from the bundled Pi Agent SDK).

```bash
pnpm add -g @yorz/cli

# or

npm install -g @yorz/cli
```

## Quick Start

### Start the Service

```bash
yorz serve
```

This starts the YorZ Service, which runs in the background by default. Open `http://localhost:7423` in your browser to access the dashboard.

To stop the background service:

```bash
yorz serve stop
```

## Development

```bash
# Install dependencies
pnpm install

# Build CLI + GUI
pnpm build

# Start the local CLI service in the foreground
pnpm dev:cli

# In another terminal, start the GUI dev server
pnpm dev:gui

# Run tests
pnpm test
```
