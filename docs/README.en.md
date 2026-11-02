# Serpent Documentation

Documentation is organized into two parts: **Public documentation** (distributed with the product) and **Internal development records** (for development process, not distributed).

## Public Documentation

| Document | Description |
| --- | --- |
| [User Guide](user-guide/README.en.md) | Install, import, browse, search and filter, tags/collections, viewer, AI analysis, plugins/MCP, troubleshooting (Bilingual) |
| [Developer Docs](developer/README.en.md) | Local development, architecture, testing, build & packaging (Bilingual; shipped on `main`) |
| [Contributing Guide](developer/contributing.en.md) | Community collaboration guidelines, Pull Request standards, and code submission workflows |
| [Extension Author Manual](manual/README.md) | Plugin, script, and MCP development guides and API references |
| [Product Brief](product-brief.md) | Product vision and MVP boundaries |
| [Glossary](glossary.md) | Domain terminology |

## Internal Development Records (Not Distributed)

Development process documents live in [`docs/internal/`](internal/_index.md) on `dolag_dev` (not published to the site): architectural decisions (ADR), implementation specifications, development logs, QA reports, code reviews, technical research, development workflows, and project status.

> AI agent instructions are in `AGENTS.md` and `CLAUDE.md`.

## Reading locally

Documentation navigation uses relative paths. The references to internal records now open a local snapshot downloaded from a fixed `dolag_dev` commit; see [snapshot sources, license and scope](internal/_upstream-import.md). Secondary references outside this download, Issues, releases, forks and external repositories retain online destinations.

In Obsidian, open the repository root as the vault to navigate to Markdown files outside `docs/`, such as `CONTRIBUTORS.md`. A vault rooted at `docs/` covers documentation inside that directory; source and test paths in the [code navigation map (Chinese)](developer/architecture-code-map.zh-CN.md) are relative to the repository root and can be inspected in your editor.
