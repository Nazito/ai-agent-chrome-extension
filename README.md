# Jarvis

Chrome MV3 side panel for live meetings: tab captions, EN↔RU translation, on-page plaques, question answers, screen-task scan, word lookup.

## Setup

```bash
npm install
npm run build
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → folder `dist/` (not `src/`).

Click the icon to open the side panel. UI language follows Chrome (`en` / `ru`).

After each build, reload the extension. If plaques on the meeting tab look old, refresh that tab too.

## Agent / contributor docs

- [CONSTITUTION.md](CONSTITUTION.md) — product and engineering rules
- [AGENTS.md](AGENTS.md) — where to edit, commands, hard rules
- `.cursor/rules/` — Cursor always-on + file-scoped rules

## Layout

| Path | Role |
| --- | --- |
| `src/sidepanel/` | Side panel |
| `src/overlay/` | In-page plaques |
| `src/background.ts` | Service worker |
| `src/shared/` | LLM, Google Translate, messages, storage |
| `src/_locales/` | EN/RU copy |

API keys stay in the extension storage. Copy the key from the side panel if you set up a second machine.
