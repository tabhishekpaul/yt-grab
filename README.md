# YT Grab

A cross-platform desktop **video & audio downloader** — **Tauri 2 + Rust** with a bundled
**yt-dlp** engine. Soft glassmorphism UI, light/dark/system themes, quality presets, a full
advanced-options panel, and a self-updating engine. Targets **macOS, Windows, and Linux**.

## Features

- **Auto-fetch** — paste a link and the title, uploader, duration, thumbnail, and playlist
  info load automatically. The **Download button stays disabled until a fetch succeeds**.
- **Normal / Advanced tabs** — a clean preset picker, or a grouped advanced panel.
- **Presets + custom presets** — built-ins (Best, 1080p/720p MP4, MKV, MP3/M4A/FLAC/Opus)
  plus **Save as preset** to store your own; applied with one tap, deletable.
- **Global vs per-download scopes** — edit **Global defaults** (persisted) or tweak **just
  this download** (a working copy seeded from global), via a scope toggle.
- **Advanced options** — mode, max resolution, container, specific format (picked from the
  fetched formats), prefer codec/60fps, **trim with a range slider** (`--download-sections`),
  split chapters, subtitles + auto-subs, SponsorBlock, thumbnail/metadata/chapters embedding,
  output folder, filename template, rate limit, concurrent fragments, Force IPv4,
  Android-client throttle bypass, playlist item ranges, skip-already-downloaded, extra args.
- **Batch** — paste multiple links to queue them all at once.
- **Downloads screen with tabs** — **Downloading** / **Downloaded** with live counts; each job
  shows thumbnail, title, progress, speed/ETA, a collapsible log, **Cancel**, **Show in folder**.
- **Desktop notifications** on completion.
- **Themes** — System / Light / Dark; **persistent settings** saved on-disk and restored.
- **Private cookie jar** — reused across runs (no browser access); resettable in Settings.
- **Self-updating engine** — **Settings → Update engine** fetches the latest yt-dlp release at
  runtime (YouTube changes regularly break older versions).

## How it works

- **Engine:** the app drives `yt-dlp` (current YouTube + hundreds of sites). The official
  **onedir** distribution is bundled as an app resource — repacked to a high-compression
  **LZMA `tar.xz`** on **macOS/Linux** (~27 MB vs ~52 MB as a zip), and kept as the native
  **`.zip`** on **Windows** (no `xz` needed there). On first launch it's **extracted once**
  into the app-data dir (guarded by a `.complete` marker, re-extracted if deleted) and the
  launcher is run directly via `tokio::process` — **~0.2 s startup** with no per-run unpacking.
  No Python at runtime.
- **Why onedir, not the single binary:** the single-file `yt-dlp` is a PyInstaller *onefile*
  that re-extracts its whole runtime to a temp dir on *every* run (~8 s). The onedir keeps its
  `_internal/` on disk, validated once by the OS, so subsequent runs are instant.
- **Self-update:** downloads the latest onedir zip from GitHub, extracts it into a versioned
  app-data folder, and points the engine at it (falls back to the bundled version on failure).
- **Fast metadata:** `fetch_info` runs `yt-dlp -J --flat-playlist` with
  `--extractor-args youtube:player_skip=js` and bounded retries/socket timeout — skipping the
  player-JS (nsig) step avoids computing every format URL (~40 s → ~10 s), with a hard backend
  timeout plus a frontend safety guard.
- **ffmpeg:** used to merge separate HD video/audio streams and convert audio. The app passes
  `--ffmpeg-location` automatically when ffmpeg is found.

## Requirements

- **Dev:** Rust (1.77+), Node 18+, Tauri 2 prerequisites, and `tar`/`xz`/`unzip` (for repacking
  the engine at build time).
- **Runtime:** `ffmpeg` on `PATH` — required for HD merge and audio conversion (`yt-dlp` is
  bundled). The Settings tab shows engine + ffmpeg status.

## Develop

```bash
npm install
npm run tauri dev
```

`beforeDevCommand` / `beforeBuildCommand` run `scripts/fetch-ytdlp.mjs`, which downloads the
yt-dlp onedir for the current target triple and repacks it to
`src-tauri/engine/ytdlp-engine.txz` (cached per release).

## Build a release bundle

```bash
npm run tauri build
```

Produces a `.dmg`/`.app` (macOS), `.msi`/`.exe` (Windows), or `.deb`/`.AppImage`/`.rpm`
(Linux), each embedding that platform's yt-dlp onedir (`tar.xz`).

> Cross-compiling? Set `TAURI_ENV_TARGET_TRIPLE` (Tauri sets this automatically, and the CI
> workflow passes it from the build matrix) so the fetch script grabs the matching engine.

### macOS install note

The bundle is **unsigned** (no Apple Developer cert). A locally-built `.app` runs directly;
opening a downloaded `.dmg` triggers Gatekeeper — right-click → **Open**, or add
codesigning/notarization.

## Mobile?

Not supported, by design. The app spawns the `yt-dlp` binary as a subprocess: **iOS forbids
that entirely** (and bans downloaders), and **Android** would need a different engine
(`youtubedl-android`, Python-embedded) and off-store distribution. This is a desktop app.

## CI

`.github/workflows/build.yml` builds installers on macOS (Apple Silicon + Intel), Linux, and
Windows, uploads artifacts on push/PR, and drafts a GitHub Release on a `v*` tag. Each runner
fetches/repacks only its own platform's engine.

## Project layout

```
index.html, src/            Frontend (Vite + vanilla JS): tabs, scopes, presets, queue, themes
scripts/fetch-ytdlp.mjs     Per-target yt-dlp onedir downloader + tar.xz repacker (build hook)
src-tauri/src/lib.rs        Engine extract-once/self-update + commands: check_dependencies,
                            default_download_dir, fetch_info, start_download, cancel_download,
                            reset_cookies, update_engine, cached_avatar, refresh_avatar
src-tauri/tauri.conf.json   Window, bundle resources (engine tar.xz), config
src-tauri/capabilities/     dialog / opener / store / notification permissions
src-tauri/engine/           Built engine (tar.xz + version) — git-ignored
.github/workflows/build.yml Cross-platform build & release CI
```

## Tech stack

Tauri 2 · Rust · vanilla JS + Vite · yt-dlp (onedir) · ffmpeg · plugins: dialog, opener, store,
notification · `lzma-rs` + `tar` (engine) · `ureq` + `zip` (self-update).

## Author

Built by **Abhishek Paul Thotakura** — <tabhishekpaul@gmail.com> · https://github.com/tabhishekpaul

## License

[MIT](LICENSE) — free and open source. yt-dlp is public domain (Unlicense); ffmpeg is a separate
runtime dependency under its own license and is not bundled.

> Note: downloading content may be subject to the source site's terms of service and your local
> laws. Use it responsibly for content you're permitted to download.
