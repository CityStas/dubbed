# Dubbed: Express AI Video Translator

<p>Voice-over AI dubbing for foreign films, series and videos</p>

Extension/userscript that adds instant AI voice-over translation and subtitles
to videos on any site with a player.

- **Version:** 1.0.0
- **Extension build:** `npm run build:chrome` → `dist-ext/chrome/`
- **Userscript build:** `npm run build:gm` → `dist/dubbed.user.js`
- **Rezka patch:** `node scripts/apply-rezka-patch.mjs` (idempotent, run before build)
- **Project map:** `../README-DUBBED.md`
- **Test harness:** `../dubbed-playwright-test/`

> Distributed under the MIT license. The underlying technology is a
