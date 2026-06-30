// Builds the bundled engine from the official yt-dlp *onedir* for the current
// target, placed at src-tauri/engine/ + a ytdlp-engine.version file:
//   - Windows: the onedir .zip is bundled as-is (native, fast)  -> ytdlp-engine.zip
//   - macOS / Linux: repacked as high-compression LZMA tar.xz   -> ytdlp-engine.txz
// The Rust side extracts it ONCE into app-data and runs the launcher directly,
// so there is no per-run unpacking (~0.2s startup).
import { execSync } from "node:child_process";
import {
  existsSync, mkdirSync, statSync, writeFileSync, readFileSync,
  rmSync, renameSync, copyFileSync, createWriteStream,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineDir = join(__dirname, "..", "src-tauri", "engine");
const txzPath = join(engineDir, "ytdlp-engine.txz");
const zipDest = join(engineDir, "ytdlp-engine.zip");
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
const isWindows = triple.includes("windows");
const outPath = isWindows ? zipDest : txzPath; // the file we ultimately bundle

async function resolveRelease() {
  const api =
    release === "latest"
      ? "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
      : `https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/${release}`;
  // Authenticate when a token is available (CI) — unauthenticated api.github.com
  // is rate-limited and 403s when several matrix jobs hit it at once.
  const headers = { "User-Agent": "yt-grab-build" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(api, { headers });
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

if (existsSync(outPath) && existsSync(verPath)) {
  try {
    if (readFileSync(verPath, "utf8").trim() === tag && statSync(outPath).size > 1_000_000) {
      console.log(`[fetch-ytdlp] cached: ${asset} @ ${tag}`);
      process.exit(0);
    }
  } catch {}
}

mkdirSync(engineDir, { recursive: true });
const work = join(tmpdir(), `ytgrab-engine-${process.pid}`);
const zipFile = join(work, "engine.zip");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${asset}`;
console.log(`[fetch-ytdlp] target ${triple}`);
console.log(`[fetch-ytdlp] downloading ${asset} @ ${tag}`);

function q(p) { return `"${p}"`; }

try {
  await download(url, zipFile);

  if (isWindows) {
    // Native: ship the onedir zip directly (no xz needed on Windows).
    copyFileSync(zipFile, zipDest);
    rmSync(txzPath, { force: true });
    console.log(`[fetch-ytdlp] bundled zip: ${(statSync(zipDest).size / 1e6).toFixed(1)} MB`);
  } else {
    // macOS / Linux: extract then repack as high-compression tar.xz.
    console.log("[fetch-ytdlp] repacking as tar.xz…");
    const extractDir = join(work, "onedir");
    mkdirSync(extractDir, { recursive: true });
    if (process.platform === "linux") {
      execSync(`unzip -q -o ${q(zipFile)} -d ${q(extractDir)}`, { stdio: "inherit" });
    } else {
      execSync(`tar -xf ${q(zipFile)} -C ${q(extractDir)}`, { stdio: "inherit" }); // bsdtar reads zip
    }
    const tarFile = join(work, "engine.tar");
    execSync(`tar -cf ${q(tarFile)} -C ${q(extractDir)} .`, { stdio: "inherit" });
    execSync(`xz -9 -T0 -f ${q(tarFile)}`, { stdio: "inherit" }); // -> engine.tar.xz
    renameSync(`${tarFile}.xz`, txzPath);
    rmSync(zipDest, { force: true });
    console.log(`[fetch-ytdlp] tar.xz: ${(statSync(txzPath).size / 1e6).toFixed(1)} MB`);
  }
  writeFileSync(verPath, tag + "\n");
  console.log(`[fetch-ytdlp] done @ ${tag} -> ${outPath}`);
} catch (e) {
  console.error(`[fetch-ytdlp] FAILED: ${e.message}`);
  process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
