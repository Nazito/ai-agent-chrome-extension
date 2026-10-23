# Jarvis constitution

Chrome MV3 extension for live meetings: listen, translate, answer, scan the screen. Product name is Jarvis. UI language follows Chrome (`en` / `ru`) via `chrome.i18n`.

This file is law for humans and agents. If a change fights these rules, change the code, not the rules, unless the user explicitly changes the product.

## Product

- Side panel is the control surface. On-page plaques (original, translation, questions, scan) sit on the meeting / task tab.
- Tab audio STT + translation uses the selected LLM provider (OpenAI / Groq / Gemini). Keys live in `chrome.storage.local`, never in git.
- Sidebar word lookup is EN↔RU via Google Translate (then Chrome Translator). It must not spend LLM quota.
- Closing a translation plaque must stay closed until the user clicks captions-on-screen (`reopen: true`). Keep-alive `ENABLE_OVERLAY` must not reopen them.
- Overlay stealth hides in-page plaques from **tab** capture only. Full-screen / Chrome-window share still leaks the side panel and PiP. Do not promise OS-level capture exclusion.
- Screen scan crops a user rectangle and asks a **vision** model. Groq vision is Llama 4 Scout, then Qwen 3.8. Groq `Access denied / network settings` is a network block (VPN), not a capture bug.

## Layout

```
src/background.ts          service worker, overlay inject, tab capture
src/sidepanel/             panel UI, listen, lookup, scan, settings
src/overlay/index.ts       in-page HUD IIFE (plaques)
src/offscreen/             tab audio worklet host
src/shared/llm.ts          STT, translate, extract, answer, vision
src/shared/googleTranslate.ts
src/shared/messages.ts     ExtensionMessage types
src/_locales/{en,ru}/messages.json
```

Edit `src/`. Load unpacked **`dist/`** after `npm run build`. Never tell the user to load `src/`.

## Engineering

- TypeScript strict, ES2022 modules, `rootDir: src`, `outDir: dist`.
- All user-visible strings go through `chrome.i18n`. Add both `en` and `ru` keys in the same change.
- `src/sidepanel/index.ts`: declare every `let` / `const` at the top. Never call a helper at load that touches a `const` declared later (TDZ).
- Overlay JS or overlay CSS change: bump `HUD_REV` in `src/overlay/index.ts` so already-injected tabs remount.
- Groq/Gemini model lists go stale. Prefer current public model IDs; treat 404 / access-denied / model-not-found as retryable for the next model, not for quota/429.
- Do not use LLM for the word field. Do not use a text-only model for screen scan.

## Git

- Default branch is `main`. A fresh clone must work from `main`.
- Commits: `JHE-000N: short lowercase description`.
- Feature branches: `JHE-000N-kebab-case`.
- Commit and push only when the user asks. When they say push to main, merge/commit on `main` and `git push origin main` (never force-push `main`).
- API keys, `.env`, `secrets.*.js` stay out of git.

## Verify

- After UI/layout/copy changes in the side panel, rebuild and say to reload unpacked `dist/`.
- Overlay changes also need a refresh of the meeting tab.
- There is no app server. Do not invent localhost URLs.
