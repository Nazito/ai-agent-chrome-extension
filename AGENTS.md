# Agent bootstrap

Read `CONSTITUTION.md` before changing code. Cursor also loads `.cursor/rules/`.

## Run

```bash
npm install
npm run build
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → select **`dist/`**.

Reload the extension after every build. If overlay plaques look stale, also refresh the meeting tab (`HUD_REV`).

## Where to change what

| Task | Files |
| --- | --- |
| Side panel UI | `src/sidepanel/index.html`, `index.ts`, `styles.css` |
| Plaques / stealth / scan box | `src/overlay/index.ts` (+ bump `HUD_REV`) |
| Inject / capture / overlay routing | `src/background.ts` |
| LLM, STT, vision | `src/shared/llm.ts` |
| Word lookup | `src/shared/googleTranslate.ts` |
| Copy, EN/RU strings | `src/_locales/en/messages.json` and `ru/messages.json` |
| Message types | `src/shared/messages.ts` |

## Hard rules

- UI strings: `chrome.i18n` only. Patch **en and ru** together.
- Side panel: all `let`/`const` at the top of `index.ts` (TDZ).
- Overlay edit: increment `HUD_REV`.
- Word lookup ≠ LLM. Screen scan ≠ text-only model.
- Do not commit unless asked. Do not force-push `main`.

## Current product facts

- Providers: `openai`, `groq`, `gemini`. Keys in `chrome.storage.local`.
- Word field: Google Translate, language from `lookupDirection` / `looksRussian`.
- Closed plaques persist in `overlayClosedOriginal` / `overlayClosedTranslation`. Reopen only with `ENABLE_OVERLAY` + `reopen: true` (captions button / `openCaptionWindow`).
- Groq screen-scan vision: `meta-llama/llama-4-scout-17b-16e-instruct`, then `qwen/qwen3.8-27b`.
