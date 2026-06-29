// Builds the bundled engine: downloads the official yt-dlp *onedir* zip for the
// current target, then repacks it as a high-compression tar.xz (~half the size
// of the deflate zip) at:
//   src-tauri/engine/ytdlp-engine.txz  (+ ytdlp-engine.version)
//
// The onedir is a small launcher + an `_internal/` runtime. The Rust side
// extracts the tar.xz ONCE into the app-data dir and runs the launcher
// directly — no per-run unpacking (~0.2s startup).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineDir = join(__dirname, "..", "src-tauri", "engine");
const txzPath = join(engineDir, "ytdlp-engine.txz");
const verPath = join(engineDir, "ytdlp-engine.version");

function hostTriple() {
  try {
    const m = execSync("rustc -vV", { encoding: "utf8" }).match(/host:\s*(\S+)/);
    if (m) return m[1];
  } catch {}
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

function assetFor(triple) {
  if (triple.includes("apple-darwin")) return "yt-dlp_macos.zip";
  if (triple.includes("windows")) {
    if (triple.startsWith("aarch64")) return "yt-dlp_win_arm64.zip";
    if (triple.startsWith("i686") || triple.startsWith("i586")) return "yt-dlp_win_x86.zip";
    return "yt-dlp_win.zip";
  }
  if (triple.startsWith("aarch64")) return "yt-dlp_linux_aarch64.zip";
  if (triple.startsWith("armv7") || triple.startsWith("arm-")) return "yt-dlp_linux_armv7l.zip";
  return "yt-dlp_linux.zip";
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const release = process.env.YTDLP_RELEASE || "latest";
const asset = assetFor(triple);

async function resolveRelease() {
  const api =
    release === "latest"
      ? "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
      : `https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/${release}`;
  const res = await fetch(api, { headers: { "User-Agent": "yt-grab-build" } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return (await res.json()).tag_name;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") || 0);
  const file = createWriteStream(dest);
  let got = 0, last = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    file.write(Buffer.from(value));
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= last + 10) { last = pct; process.stdout.write(`\r[fetch-ytdlp] ${pct}%`); }
    }
  }
  await new Promise((r) => file.end(r));
  process.stdout.write("\n");
}

const tag = await resolveRelease();

if (existsSync(txzPath) && existsSync(verPath)) {
  try {
    if (readFileSync(verPath, "utf8").trim() === tag && statSync(txzPath).size > 1_000_000) {
      console.log(`[fetch-ytdlp] cached: ${asset} @ ${tag}`);
      process.exit(0);
    }
  } catch {}
}

mkdirSync(engineDir, { recursive: true });
const work = join(tmpdir(), `ytgrab-engine-${process.pid}`);
const zipFile = join(work, "engine.zip");
const extractDir = join(work, "onedir");
rmSync(work, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${asset}`;
console.log(`[fetch-ytdlp] target ${triple}`);
console.log(`[fetch-ytdlp] downloading ${asset} @ ${tag}`);

try {
  await download(url, zipFile);
  // Extract the official zip. bsdtar (macOS/Windows) reads zip; Linux uses unzip.
  console.log("[fetch-ytdlp] repacking as high-compression tar.xz…");
  if (process.platform === "linux") {
    execSync(`unzip -q -o "${zipFile}" -d "${extractDir}"`, { stdio: "inherit" });
  } else {
    execSync(`tar -xf "${zipFile}" -C "${extractDir}"`, { stdio: "inherit" });
  }
  // tar | xz -9 -> single compressed archive.
  execSync(`tar -cf - -C "${extractDir}" . | xz -9 -T0 -c > "${txzPath}"`, { stdio: "inherit", shell: "/bin/sh" });
  writeFileSync(verPath, tag + "\n");
  console.log(`[fetch-ytdlp] done: ${(statSync(txzPath).size / 1e6).toFixed(1)} MB -> ${txzPath}`);
} catch (e) {
  console.error(`[fetch-ytdlp] FAILED: ${e.message}`);
  process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
