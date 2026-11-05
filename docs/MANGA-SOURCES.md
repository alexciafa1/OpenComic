# Manga sources

The **Manga sources / Sorgenti manga** item in the sidebar opens the integrated source browser. It uses the same Material Design theme, languages, tabs and chapter reader as the rest of OpenComic.

1. Open **Repositories** and paste a Mihon/Tachiyomi repository or extension store URL. HTTP and HTTPS URLs are accepted; no repository is hardcoded or enabled automatically.
2. Open **Extensions**, filter by name or language, and install an extension you trust. Installed extensions can be updated or uninstalled here.
3. Open **Sources**, choose a source, browse popular or recently updated titles, or search by title.
4. Choose a manga and a chapter. OpenComic downloads the chapter's pages, then opens them in its existing reader. Reading modes, shortcuts and local reading progress continue to work. Back returns to the chapter list. Completed chapters also appear in Recents and can be reopened offline.

The URL supplied for testing was `https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json`. Suwayomi 2.4.2366 automatically migrated this legacy URL to Keiyoushi's current protobuf store and returned 1,463 extensions during validation. The source browser does not depend on this repository. Source availability and individual website restrictions remain dependent on the upstream extension and website; advanced source-specific preferences and website challenge/login flows are not implemented in this first integration.

## Runtime and packaging

Tachiyomi extensions contain Android bytecode, not desktop JavaScript. This implementation uses **Suwayomi-Server 2.4.2366** as a compatibility engine. The pinned official distribution includes its own JRE, so the packaged application does not require a system Java installation, a separate server application, or a second browser window. Only the server and JRE are bundled, not Suwayomi's Electron launcher. Its MPL 2.0 license, source URL and Java notices are included alongside the runtime.

```sh
npm install
npm run sources-runtime
npm run prebuild-start
npm start
```

`npm run sources-runtime` downloads the official runtime for the current platform, verifies a pinned SHA-256 checksum and extracts it into the ignored `build/runtime/suwayomi/<platform>-<arch>` directory. You can specify a supported build target explicitly, for example `npm run sources-runtime -- darwin-x64`. Available upstream bundles are macOS arm64/x64, Linux x64 and Windows x64. Only macOS arm64 was built and tested for this change. Unsupported targets fail explicitly.

```sh
npm run build-mac-sources
```

This creates a development DMG for the current Mac architecture, with Java and Suwayomi copied to `OpenComic.app/Contents/Resources/suwayomi`. This development build uses a local ad hoc signature and has no Developer ID signature or notarization. Public distribution should use the project's normal signing/notarization setup. Existing build scripts also include the runtime if prepared for the target architecture.

The source engine starts lazily on a dynamically assigned loopback port. It has an isolated data directory, uses a random HTTP Basic password per launch, and stops when OpenComic quits. It never binds to the LAN. Requests go through a restricted Electron IPC action list; downloaded pages and covers are proxied through the engine so source cookies and Referer handling remain with the extension. Image bytes are validated and bounded. Repository URLs and remote metadata are never evaluated as renderer code or HTML.

Data is stored beside OpenComic's `storage` directory:

- `manga-source-engine`: Suwayomi database, repositories, extensions and source data.
- `manga-chapters`: completed chapter folders, keyed by stable engine namespace and chapter ID. Their paths remain stable across engine restarts, preserving OpenComic's reading progress.

Downloads use staging directories and an atomic rename after every page succeeds. Failed/cancelled downloads are removed; only complete chapters are handed to the reader. Chapters are saved in full before reading, rather than streamed one page at a time. Chapters can be removed from Recents using OpenComic's existing file actions; this also means the associated cached files should not be moved if you want to preserve their path-based reading progress.

## Validation

```sh
npm run prebuild-start
npm test
npm run test-sources-integration
node scripts/test/manga-sources-ui.cjs
```

`npm test` includes the existing lint, image codec tests and packaging dependency checks, plus the source client tests. The integration test starts the actual bundled Java/server in a temporary profile and checks authentication, browsing, chapter enumeration, thumbnails and page downloads with generated local test images.

`npm run test-sources-integration -- --repository` additionally reads the supplied Keiyoushi repository. Adding `--install` installs, registers and uninstalls its MangaDex APK; `--live` also checks its real popular catalogue and chapter list. This executes third-party extension code and is deliberately opt-in. The UI smoke test starts Electron in a temporary profile, adds the supplied repository, filters extensions, opens a local manga in the native reader and checks the Back action. It saves screenshots in `dist/test-artifacts`. To test the packaged application, set `OPENCOMIC_TEST_BINARY` to its executable path. Neither test changes the user's existing OpenComic profile.

The original packaging check requires native libraries for both Mac architectures. A default npm install on an Apple Silicon Mac may require the existing `scripts/sharp-copy-custom.js` and `scripts/zstd-copy-native.js` preparation steps described by the check's own error messages before the full packaging suite passes.

Validated on macOS Apple Silicon on 2026-11-05: the full `npm test` suite passed (4 existing codec tests, 12 source/progress tests, lint and packaging dependency checks). The live integration test imported Keiyoushi, installed/uninstalled MangaDex and fetched 20 popular titles plus a real chapter list. The final DMG passed `hdiutil verify` and its application passed `codesign --verify --deep --strict`. The UI smoke test passed directly from the read-only mounted DMG, including chapter reading and return navigation. Light and dark theme screenshots were inspected.

Progress regression fix (2026-11-05): Back now saves the chapter progress before changing navigation history. The source page avoids a second save after history becomes a root page, and stale saves ignore missing/non-string roots. Reopening a source chapter uses its saved image path. The UI regression advances pages, clicks the real reader Back button, checks saved progress, reopens at that page and tests direct history Back after another page change.
The progress regression passed directly from `OpenComic-1.6.6-arm64-progress-fix.dmg`, after signature and disk-image integrity verification.
