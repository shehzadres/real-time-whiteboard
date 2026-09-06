# Contributing

Thanks for considering a contribution. This project is developed in phases (see
[PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md) for the current phase and architecture, and
[DAILY_PROGRESS.md](./DAILY_PROGRESS.md) for a dated work log) — please skim both before making
non-trivial changes so new work fits the existing architecture instead of duplicating it.

## Getting set up

```bash
npm install
cp .env.example .env.local
npm run dev
```

See the [README](./README.md#getting-started) for full setup, including Redis (required) and
MongoDB (optional, version history only).

## Before opening a PR

Run all three — CI runs the same checks:

```bash
npx tsc --noEmit
npx eslint .
npm run build
```

A PR that fails any of these won't be merged as-is.

## Code style

- TypeScript, strict types — avoid `any` where a real type is easy to express.
- Follow the existing separation of concerns: UI components, canvas engine, socket layer, room
  management, database, Redis, WebRTC, and history/versioning each live in their own directory
  (see the Project Structure section of the README). Put new code where it already fits rather
  than introducing a new pattern for the same concern.
- Prefer modifying an existing file over creating a parallel one (`file-new.ts`, `file-v2.ts`,
  etc.) — see PROJECT_HANDOFF.md's "Change Management" section.
- Keep dependencies minimal; check whether an existing dependency already solves the problem
  before adding a new one.

## Commit / PR conventions

- Keep commits scoped to one logical change.
- Write a PR description that says *what* changed and *why*, not just *what files* changed.
- Reference the phase or issue a change relates to, if any.

## Reporting bugs / requesting features

Open an issue with:
- What you expected vs. what happened
- Steps to reproduce (for bugs)
- Whether Redis/MongoDB were running, and their versions, if relevant

## Code of conduct

Be respectful and constructive. Disagree on technical merits, assume good faith, and keep
discussion focused on the project.
