use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};

/// Tracks running yt-dlp children (for cancellation) and the resolved engine path.
#[derive(Default)]
struct AppState {
    children: Mutex<HashMap<String, Child>>,
    canceled: Mutex<HashSet<String>>,
    engine: Mutex<Option<PathBuf>>,
    extract_lock: Mutex<()>,
}

/// Options sent from the frontend for a download job.
#[derive(Debug, Deserialize, Clone)]
struct DownloadOptions {
    mode: String, // "video" | "audio"
    quality: String,
    container: String,
    audio_format: String,
    audio_quality: String,
    output_dir: Option<String>,
    template: String,
    rate_limit: Option<String>,
    playlist: bool,
    embed_thumbnail: bool,
    embed_metadata: bool,
    embed_chapters: bool,
    subtitles: bool,
    auto_subs: bool,
    sponsorblock: bool,
    subs_lang: String,
    extra_args: Option<String>,
    force_ipv4: bool,
    concurrent_fragments: String,
    bypass_throttle: bool,
    section_start: String,
    section_end: String,
    split_chapters: bool,
    format_id: String,
    prefer_codec: String,
    prefer_fps: bool,
    playlist_items: String,
    archive: bool,
}

/* --------------------------------------------------------------------- */
/* Binary discovery (for ffmpeg; yt-dlp ships as a bundled sidecar)       */
/* --------------------------------------------------------------------- */
fn find_binary(name: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join(name);
            if cand.is_file() {
                return Some(cand);
            }
            #[cfg(windows)]
            {
                let exe = dir.join(format!("{name}.exe"));
                if exe.is_file() {
                    return Some(exe);
                }
            }
        }
    }
    let mut commons: Vec<PathBuf> = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/local/bin",
        "/snap/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = dirs::home_dir() {
        commons.push(home.join(".local/bin"));
        commons.push(home.join("bin"));
    }
    for dir in commons {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn ffmpeg_dir() -> Option<String> {
    find_binary("ffmpeg").and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
}

/// Path to our own persistent cookie jar (created if missing). yt-dlp reads it
/// and writes the updated jar back after each run, so session/consent cookies
/// are reused instead of re-negotiated every time.
fn cookies_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("cookies.txt");
    if !file.exists() {
        let _ = std::fs::write(
            &file,
            "# Netscape HTTP Cookie File\n# Auto-managed by YT Grab — safe to delete.\n\n",
        );
    }
    Some(file)
}

/* --------------------------------------------------------------------- */
/* Engine: the yt-dlp onedir is bundled (zip) and extracted ONCE; the      */
/* extracted launcher is then run directly (no per-run unpacking).         */
/* --------------------------------------------------------------------- */

/// Locate the bundled engine zip + its version (resource dir when bundled,
/// source `engine/` dir during `tauri dev`).
fn engine_resource(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("engine"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("engine"));

    for dir in candidates {
        // tar.xz (macOS/Linux) or .zip (Windows) — whichever was bundled.
        for name in ["ytdlp-engine.txz", "ytdlp-engine.zip"] {
            let arc = dir.join(name);
            if arc.is_file() {
                let ver = std::fs::read_to_string(dir.join("ytdlp-engine.version"))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                return Ok((arc, if ver.is_empty() { "v0".into() } else { ver }));
            }
        }
    }
    Err("Bundled yt-dlp engine not found.".into())
}

/// Extract a bundled engine archive (.txz or .zip) into `dest`.
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    if archive.extension().and_then(|e| e.to_str()) == Some("zip") {
        extract_zip(archive, dest)
    } else {
        extract_engine(archive, dest)
    }
}

/// The yt-dlp launcher inside an extracted onedir (the top-level file that is
/// a sibling of `_internal/`).
fn find_engine_exe(dir: &Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_file() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("yt-dlp") {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Extract the engine tar.xz into `dest` (atomic via temp dir + rename).
fn extract_engine(txz_path: &Path, dest: &Path) -> Result<(), String> {
    use std::io::{BufReader, BufWriter};

    let tmp = dest.with_extension(format!("extracting.{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    // 1) xz -> a temporary .tar (avoids holding ~120 MB in memory).
    let tar_path = dest.with_extension(format!("tar.{}", std::process::id()));
    {
        let mut reader = BufReader::new(
            std::fs::File::open(txz_path).map_err(|e| format!("open engine archive: {e}"))?,
        );
        let mut writer = BufWriter::new(
            std::fs::File::create(&tar_path).map_err(|e| e.to_string())?,
        );
        lzma_rs::xz_decompress(&mut reader, &mut writer).map_err(|e| format!("xz decode: {e}"))?;
        use std::io::Write;
        writer.flush().map_err(|e| e.to_string())?;
    }

    // 2) untar into tmp (the tar crate preserves unix permissions).
    {
        let tar_file = std::fs::File::open(&tar_path).map_err(|e| e.to_string())?;
        let mut archive = tar::Archive::new(BufReader::new(tar_file));
        archive.set_preserve_permissions(true);
        archive.unpack(&tmp).map_err(|e| format!("untar: {e}"))?;
    }
    let _ = std::fs::remove_file(&tar_path);

    // Mark complete only after a successful unpack.
    std::fs::write(tmp.join(".complete"), b"ok").map_err(|e| e.to_string())?;

    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("finalize engine: {e}"))?;
    Ok(())
}

/// Ensure the onedir is extracted once and return the path to its launcher.
/// Re-extracts if missing/incomplete. Cached after first use, so subsequent
/// invocations run the extracted launcher directly (no unpacking).
fn ensure_engine(app: &AppHandle) -> Result<PathBuf, String> {
    {
        let cached = app.state::<AppState>().engine.lock().unwrap().clone();
        if let Some(p) = cached {
            if p.exists() {
                return Ok(p);
            }
        }
    }
    let (archive, bundled_version) = engine_resource(app)?;
    let root = engine_root(app)?;

    // Serialize so the eager-startup thread and a command don't race.
    let state = app.state::<AppState>();
    let _guard = state.extract_lock.lock().unwrap();

    // Prefer an updated version (from `current`), else the bundled one.
    let preferred = std::fs::read_to_string(root.join("current"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| bundled_version.clone());

    // Use the preferred version if it's already extracted; otherwise fall back
    // to extracting the bundled engine.
    let pref_dir = root.join(&preferred);
    let exe = if find_engine_exe(&pref_dir).is_some_and(|e| e.exists())
        && pref_dir.join(".complete").exists()
    {
        find_engine_exe(&pref_dir).unwrap()
    } else {
        let dest = root.join(&bundled_version);
        if !(find_engine_exe(&dest).is_some_and(|e| e.exists()) && dest.join(".complete").exists()) {
            extract_archive(&archive, &dest)?;
        }
        find_engine_exe(&dest)
            .ok_or_else(|| "engine launcher missing after extraction".to_string())?
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
    }
    *app.state::<AppState>().engine.lock().unwrap() = Some(exe.clone());
    Ok(exe)
}

fn engine_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("engine"))
}

/// The official onedir zip asset for this platform (used by self-update).
fn platform_asset() -> &'static str {
    if cfg!(target_os = "macos") {
        "yt-dlp_macos.zip"
    } else if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") {
            "yt-dlp_win_arm64.zip"
        } else if cfg!(target_arch = "x86") {
            "yt-dlp_win_x86.zip"
        } else {
            "yt-dlp_win.zip"
        }
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64.zip"
    } else {
        "yt-dlp_linux.zip"
    }
}

/// Extract a onedir .zip into `dest` (atomic via temp dir + rename).
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let tmp = dest.with_extension(format!("extracting.{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = match f.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => continue,
        };
        let out = tmp.join(&rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = f.unix_mode() {
                    let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
                }
            }
        }
    }
    std::fs::write(tmp.join(".complete"), b"ok").map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(dest);
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("finalize: {e}"))?;
    Ok(())
}

/// Download the latest yt-dlp onedir from GitHub and switch the engine to it.
fn do_update_engine(app: &AppHandle) -> Result<String, String> {
    let latest: serde_json::Value =
        ureq::get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
            .set("User-Agent", "yt-grab")
            .call()
            .map_err(|e| format!("checking latest: {e}"))?
            .into_json()
            .map_err(|e| e.to_string())?;
    let tag = latest["tag_name"]
        .as_str()
        .ok_or("could not read latest version")?
        .to_string();

    let root = engine_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let bundled = engine_resource(app).map(|(_, v)| v).unwrap_or_default();
    let in_use = std::fs::read_to_string(root.join("current"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(bundled);
    if tag == in_use {
        return Ok(tag); // already on the latest
    }

    // Download the platform onedir zip.
    let url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/{}",
        platform_asset()
    );
    let resp = ureq::get(&url)
        .set("User-Agent", "yt-grab")
        .call()
        .map_err(|e| format!("downloading engine: {e}"))?;
    let tmp_zip = root.join(format!(".update-{}.zip", std::process::id()));
    {
        let mut reader = resp.into_reader();
        let mut file = std::fs::File::create(&tmp_zip).map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut file).map_err(|e| format!("saving engine: {e}"))?;
    }

    let dest = root.join(&tag);
    {
        let state = app.state::<AppState>();
        let _guard = state.extract_lock.lock().unwrap();
        extract_zip(&tmp_zip, &dest)?;
    }
    let _ = std::fs::remove_file(&tmp_zip);
    std::fs::write(root.join("current"), &tag).map_err(|e| e.to_string())?;

    if let Some(exe) = find_engine_exe(&dest) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
        *app.state::<AppState>().engine.lock().unwrap() = Some(exe);
    }
    Ok(tag)
}

#[tauri::command]
async fn update_engine(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || do_update_engine(&app))
        .await
        .map_err(|e| e.to_string())?
}

/* --------------------------------------------------------------------- */
/* Developer avatar (cached for offline; refreshed when online)           */
/* --------------------------------------------------------------------- */
fn encode_avatar(bytes: &[u8]) -> String {
    use base64::Engine;
    let mime = if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else {
        "image/png"
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{b64}")
}

#[tauri::command]
fn cached_avatar(app: AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("avatar.img");
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(encode_avatar(&bytes))
}

#[tauri::command]
async fn refresh_avatar(app: AppHandle, username: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let url = format!("https://github.com/{username}.png?size=128");
        let resp = ureq::get(&url)
            .set("User-Agent", "yt-grab")
            .call()
            .map_err(|e| e.to_string())?;
        let mut bytes: Vec<u8> = Vec::new();
        resp.into_reader()
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return Err("empty avatar".into());
        }
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("avatar.img"), &bytes);
        }
        Ok(encode_avatar(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run the engine and capture stdout, with a wall-clock timeout that kills it.
async fn run_capture(
    exe: &Path,
    args: &[String],
    secs: u64,
) -> Result<(Vec<u8>, String, Option<i32>), String> {
    let mut child = TokioCommand::new(exe)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start engine: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let collect = async {
        let _ = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
        );
        child.wait().await
    };
    match tokio::time::timeout(std::time::Duration::from_secs(secs), collect).await {
        Ok(Ok(status)) => {
            let e = String::from_utf8_lossy(&err);
            let last = e
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .to_string();
            Ok((out, last, status.code()))
        }
        Ok(Err(e)) => Err(format!("engine error: {e}")),
        Err(_) => {
            let _ = child.start_kill();
            Err("Timed out — the link may be slow, private, or unavailable.".into())
        }
    }
}

/* --------------------------------------------------------------------- */
/* Commands                                                               */
/* --------------------------------------------------------------------- */
#[tauri::command]
async fn check_dependencies(app: AppHandle) -> Value {
    let ytdlp = match ensure_engine(&app) {
        Ok(exe) => match run_capture(&exe, &["--version".to_string()], 60).await {
            Ok((out, _, Some(0))) => Some(String::from_utf8_lossy(&out).trim().to_string()),
            _ => None,
        },
        Err(_) => None,
    };

    let ffmpeg = find_binary("ffmpeg").and_then(|p| {
        let out = std::process::Command::new(&p).arg("-version").output().ok()?;
        let line = String::from_utf8_lossy(&out.stdout);
        line.lines().next().map(|l| {
            l.replace("ffmpeg version ", "")
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        })
    });

    json!({ "ytdlp": ytdlp, "ffmpeg": ffmpeg })
}

#[tauri::command]
fn default_download_dir() -> String {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
async fn fetch_info(app: AppHandle, url: String) -> Result<Value, String> {
    let mut args: Vec<String> = [
        "-J",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-config",
        // Bound the time yt-dlp can spend: short socket timeout and few
        // retries (defaults are 10 network + 3 extractor retries).
        "--socket-timeout",
        "15",
        "--retries",
        "2",
        "--extractor-retries",
        "1",
        "--no-progress",
        // Skip the player JS step (nsig deciphering) — we only need
        // metadata, and computing every format URL takes ~40s otherwise.
        "--extractor-args",
        "youtube:player_skip=js",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(cf) = cookies_file(&app) {
        args.push("--cookies".into());
        args.push(cf.to_string_lossy().into_owned());
    }
    args.push(url.clone());

    let exe = ensure_engine(&app)?;
    let (stdout, last_err, code) = run_capture(&exe, &args, 25).await?;

    if code != Some(0) {
        return Err(if last_err.is_empty() {
            "yt-dlp could not read this URL.".to_string()
        } else {
            last_err
        });
    }

    let v: Value = serde_json::from_slice(&stdout).map_err(|e| format!("Bad JSON: {e}"))?;
    let is_playlist = v.get("_type").and_then(|t| t.as_str()) == Some("playlist");
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let uploader = v
        .get("uploader")
        .or_else(|| v.get("channel"))
        .or_else(|| v.get("uploader_id"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let thumbnail = pick_thumbnail(&v).or_else(|| {
        v.get("entries")
            .and_then(|e| e.as_array())
            .and_then(|a| a.first())
            .and_then(pick_thumbnail)
    });
    let count = v
        .get("entries")
        .and_then(|e| e.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let duration = v.get("duration").and_then(|d| d.as_f64());

    Ok(json!({
        "title": title,
        "uploader": uploader,
        "duration": duration,
        "thumbnail": thumbnail,
        "is_playlist": is_playlist,
        "count": count,
        "formats": extract_formats(&v),
    }))
}

fn human_size(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1_073_741_824.0 {
        format!("{:.2} GB", b / 1_073_741_824.0)
    } else if b >= 1_048_576.0 {
        format!("{:.0} MB", b / 1_048_576.0)
    } else if b >= 1024.0 {
        format!("{:.0} KB", b / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn short_codec(c: &str) -> &str {
    if c.starts_with("avc1") || c.starts_with("h264") {
        "H.264"
    } else if c.starts_with("vp9") || c.starts_with("vp09") {
        "VP9"
    } else if c.starts_with("av01") {
        "AV1"
    } else if c.starts_with("hev") || c.starts_with("h265") {
        "H.265"
    } else {
        ""
    }
}

/// Build a UI-friendly list of selectable formats from the `-J` output.
fn extract_formats(v: &Value) -> Vec<Value> {
    let arr = match v.get("formats").and_then(|f| f.as_array()) {
        Some(a) => a,
        None => return vec![],
    };
    let size_of = |f: &Value| {
        f.get("filesize")
            .or_else(|| f.get("filesize_approx"))
            .and_then(|s| s.as_u64())
    };

    let mut videos: Vec<(u64, Value)> = Vec::new();
    let mut audios: Vec<(u64, Value)> = Vec::new();
    for f in arr {
        let fid = f.get("format_id").and_then(|i| i.as_str()).unwrap_or("");
        if fid.is_empty() {
            continue;
        }
        let ext = f.get("ext").and_then(|e| e.as_str()).unwrap_or("");
        let vcodec = f.get("vcodec").and_then(|c| c.as_str()).unwrap_or("none");
        let acodec = f.get("acodec").and_then(|c| c.as_str()).unwrap_or("none");

        if let Some(h) = f.get("height").and_then(|h| h.as_u64()) {
            let fps = f.get("fps").and_then(|x| x.as_f64()).map(|x| x.round() as u64);
            let mut label = format!("{h}p");
            if let Some(fp) = fps {
                if fp >= 50 {
                    label.push_str(&format!(" {fp}fps"));
                }
            }
            label.push_str(&format!(" · {ext}"));
            let vc = short_codec(vcodec);
            if !vc.is_empty() {
                label.push_str(&format!(" · {vc}"));
            }
            if acodec != "none" {
                label.push_str(" · has audio");
            }
            if let Some(sz) = size_of(f) {
                label.push_str(&format!(" · {}", human_size(sz)));
            }
            videos.push((h, json!({ "id": fid, "label": label })));
        } else if vcodec == "none" && acodec != "none" {
            let abr = f.get("abr").and_then(|x| x.as_f64()).unwrap_or(0.0) as u64;
            let mut label = format!("audio {abr}k · {ext}");
            if let Some(sz) = size_of(f) {
                label.push_str(&format!(" · {}", human_size(sz)));
            }
            audios.push((abr, json!({ "id": fid, "label": label })));
        }
    }

    videos.sort_by(|a, b| b.0.cmp(&a.0));
    audios.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<Value> = videos.into_iter().map(|(_, j)| j).collect();
    out.extend(audios.into_iter().take(3).map(|(_, j)| j));
    out
}

fn pick_thumbnail(v: &Value) -> Option<String> {
    if let Some(t) = v.get("thumbnail").and_then(|t| t.as_str()) {
        return Some(t.to_string());
    }
    let arr = v.get("thumbnails")?.as_array()?;
    arr.last()
        .or_else(|| arr.first())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
}

#[tauri::command]
fn start_download(app: AppHandle, id: String, url: String, opts: DownloadOptions) {
    // Spawn into the async runtime so the Tokio process APIs run in-context
    // (spawning a tokio Command from a sync command panics: "no reactor").
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_download(&app2, &id, &url, &opts).await {
            emit(&app2, json!({ "id": id, "status": "error", "log": e }));
        }
    });
}

/// Spawn yt-dlp, stream its output to the UI, and report the final status.
async fn run_download(
    app: &AppHandle,
    id: &str,
    url: &str,
    opts: &DownloadOptions,
) -> Result<(), String> {
    let exe = ensure_engine(app)?;
    let cookies = cookies_file(app).map(|p| p.to_string_lossy().into_owned());
    let archive = if opts.archive {
        app.path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("download-archive.txt").to_string_lossy().into_owned())
    } else {
        None
    };
    let args = build_args(url, opts, cookies.as_deref(), archive.as_deref());

    let mut child = TokioCommand::new(&exe)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start engine: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    app.state::<AppState>()
        .children
        .lock()
        .unwrap()
        .insert(id.to_string(), child);

    // Merge both output streams onto one channel of lines.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let tx2 = tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if tx2.send(l).is_err() {
                break;
            }
        }
    });

    let mut final_path: Option<String> = None;
    let mut dest: Option<String> = None;
    while let Some(line) = rx.recv().await {
        let line = line.trim_end().to_string();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("DLPROG|") {
            emit_progress(app, id, rest);
            continue;
        }
        if let Some((kind, p)) = parse_path(&line) {
            match kind {
                PathKind::Final => final_path = Some(p),
                PathKind::Dest => dest = Some(p),
            }
        }
        emit(app, json!({ "id": id, "status": "running", "log": line }));
    }

    // Streams closed -> reap the process and report the outcome.
    let st = app.state::<AppState>();
    let child_opt = st.children.lock().unwrap().remove(id);
    let exit_ok = match child_opt {
        Some(mut c) => c.wait().await.ok().and_then(|s| s.code()) == Some(0),
        None => false,
    };
    let canceled = st.canceled.lock().unwrap().remove(id);

    let status = if canceled {
        "canceled"
    } else if exit_ok {
        "done"
    } else {
        "error"
    };
    emit(
        app,
        json!({ "id": id, "status": status, "percent": if exit_ok {100} else {0}, "filepath": final_path.or(dest) }),
    );
    Ok(())
}

#[tauri::command]
fn reset_cookies(app: AppHandle) -> Result<(), String> {
    if let Ok(dir) = app.path().app_data_dir() {
        let file = dir.join("cookies.txt");
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
    }
    cookies_file(&app); // recreate an empty jar
    Ok(())
}

#[tauri::command]
fn cancel_download(state: State<AppState>, id: String) {
    if let Some(child) = state.children.lock().unwrap().get_mut(&id) {
        let _ = child.start_kill();
    }
    state.canceled.lock().unwrap().insert(id);
}

/* --------------------------------------------------------------------- */
/* Argument building                                                      */
/* --------------------------------------------------------------------- */
fn build_args(
    url: &str,
    o: &DownloadOptions,
    cookies: Option<&str>,
    archive: Option<&str>,
) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let push = |a: &mut Vec<String>, s: &str| a.push(s.to_string());

    push(&mut a, "--newline");
    push(&mut a, "--ignore-config");
    push(&mut a, "--no-warnings");
    push(&mut a, "--progress-template");
    push(
        &mut a,
        "DLPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s",
    );

    if let Some(dir) = ffmpeg_dir() {
        push(&mut a, "--ffmpeg-location");
        push(&mut a, &dir);
    }

    // Format selection
    if o.mode == "audio" {
        push(&mut a, "-x");
        if o.audio_format != "best" {
            push(&mut a, "--audio-format");
            push(&mut a, &o.audio_format);
        }
        push(&mut a, "--audio-quality");
        push(&mut a, &o.audio_quality);
    } else {
        push(&mut a, "-f");
        if !o.format_id.trim().is_empty() {
            // Exact format chosen from the picker (merge best audio if needed).
            let id = o.format_id.trim();
            push(&mut a, &format!("{id}+ba/{id}/b"));
        } else {
            let q: i64 = o.quality.parse().unwrap_or(0);
            if q <= 0 {
                push(&mut a, "bv*+ba/b");
            } else {
                push(&mut a, &format!("bv*[height<={q}]+ba/b[height<={q}]"));
            }
        }
        if !o.container.is_empty() {
            push(&mut a, "--merge-output-format");
            push(&mut a, &o.container);
            push(&mut a, "--remux-video");
            push(&mut a, &o.container);
        }
        // Codec / FPS preference (yt-dlp uses given fields first, then defaults).
        let mut sort: Vec<String> = Vec::new();
        match o.prefer_codec.as_str() {
            "av01" | "vp9" | "avc1" => sort.push(format!("vcodec:{}", o.prefer_codec)),
            _ => {}
        }
        if o.prefer_fps {
            sort.push("fps".to_string());
        }
        if !sort.is_empty() {
            push(&mut a, "-S");
            push(&mut a, &sort.join(","));
        }
    }

    // Section / clip download
    let start = o.section_start.trim();
    let end = o.section_end.trim();
    if !start.is_empty() || !end.is_empty() {
        let s = if start.is_empty() { "0" } else { start };
        let e = if end.is_empty() { "inf" } else { end };
        push(&mut a, "--download-sections");
        push(&mut a, &format!("*{s}-{e}"));
        push(&mut a, "--force-keyframes-at-cuts");
    }
    if o.split_chapters {
        push(&mut a, "--split-chapters");
    }

    if o.playlist {
        push(&mut a, "--yes-playlist");
        if !o.playlist_items.trim().is_empty() {
            push(&mut a, "--playlist-items");
            push(&mut a, o.playlist_items.trim());
        }
    } else {
        push(&mut a, "--no-playlist");
    }

    if o.embed_thumbnail {
        push(&mut a, "--embed-thumbnail");
    }
    if o.embed_metadata {
        push(&mut a, "--embed-metadata");
    }
    if o.embed_chapters {
        push(&mut a, "--embed-chapters");
    }
    if o.subtitles {
        push(&mut a, "--write-subs");
        push(&mut a, "--embed-subs");
        push(&mut a, "--sub-langs");
        push(&mut a, &o.subs_lang);
    }
    if o.auto_subs {
        push(&mut a, "--write-auto-subs");
        if !o.subtitles {
            push(&mut a, "--sub-langs");
            push(&mut a, &o.subs_lang);
        }
    }
    if o.sponsorblock {
        push(&mut a, "--sponsorblock-remove");
        push(&mut a, "all");
    }

    if let Some(rl) = o.rate_limit.as_ref().filter(|s| !s.is_empty()) {
        push(&mut a, "--limit-rate");
        push(&mut a, rl);
    }
    if o.force_ipv4 {
        push(&mut a, "--force-ipv4");
    }
    let frags: i64 = o.concurrent_fragments.parse().unwrap_or(1);
    if frags > 1 {
        push(&mut a, "--concurrent-fragments");
        push(&mut a, &frags.to_string());
    }
    // Use the Android InnerTube client, which often bypasses YouTube's
    // per-format download throttling.
    if o.bypass_throttle {
        push(&mut a, "--extractor-args");
        push(&mut a, "youtube:player_client=android");
    }
    // Reuse our own persistent cookie jar (read + written back by yt-dlp).
    if let Some(cf) = cookies {
        push(&mut a, "--cookies");
        push(&mut a, cf);
    }
    // Skip already-downloaded items (incremental playlist/channel syncing).
    if let Some(ar) = archive {
        push(&mut a, "--download-archive");
        push(&mut a, ar);
    }

    let outdir = o
        .output_dir
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_download_dir);
    let template = if o.template.is_empty() {
        "%(title)s.%(ext)s".to_string()
    } else {
        o.template.clone()
    };
    let full = Path::new(&outdir).join(template);
    push(&mut a, "-o");
    push(&mut a, &full.to_string_lossy());

    if let Some(extra) = o.extra_args.as_ref().filter(|s| !s.trim().is_empty()) {
        for tok in extra.split_whitespace() {
            push(&mut a, tok);
        }
    }

    a.push(url.to_string());
    a
}

/* --------------------------------------------------------------------- */
/* Output parsing                                                         */
/* --------------------------------------------------------------------- */
enum PathKind {
    Final,
    Dest,
}

fn parse_path(line: &str) -> Option<(PathKind, String)> {
    if line.contains("Merging formats into ") {
        return quoted(line).map(|p| (PathKind::Final, p));
    }
    if let Some(idx) = line.find("[ExtractAudio] Destination: ") {
        return Some((PathKind::Final, line[idx + 28..].trim().to_string()));
    }
    if line.contains("[MoveFiles]") && line.contains(" to ") {
        if let Some(pos) = line.rfind(" to ") {
            return strip_quotes(&line[pos + 4..]).map(|p| (PathKind::Final, p));
        }
    }
    if let Some(idx) = line.find("[download] Destination: ") {
        return Some((PathKind::Dest, line[idx + 24..].trim().to_string()));
    }
    if let Some(idx) = line.find("] ") {
        if let Some(end) = line.find(" has already been downloaded") {
            return Some((PathKind::Dest, line[idx + 2..end].trim().to_string()));
        }
    }
    None
}

fn quoted(line: &str) -> Option<String> {
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

fn strip_quotes(s: &str) -> Option<String> {
    let t = s.trim();
    if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
        Some(t[1..t.len() - 1].to_string())
    } else {
        Some(t.to_string())
    }
}

fn emit_progress(app: &AppHandle, id: &str, rest: &str) {
    let parts: Vec<&str> = rest.split('|').collect();
    let percent_str = parts.first().copied().unwrap_or("").trim();
    let speed = parts.get(1).copied().unwrap_or("").trim();
    let eta = parts.get(2).copied().unwrap_or("").trim();
    let total = parts.get(3).copied().unwrap_or("").trim();

    let percent: f64 = percent_str.trim_end_matches('%').trim().parse().unwrap_or(0.0);

    let mut bits = vec![percent_str.to_string()];
    if !total.is_empty() && total != "N/A" {
        bits.push(format!("of {total}"));
    }
    if !speed.is_empty() && speed != "N/A" {
        bits.push(format!("at {speed}"));
    }
    if !eta.is_empty() && eta != "N/A" {
        bits.push(format!("ETA {eta}"));
    }

    emit(
        app,
        json!({ "id": id, "status": "running", "percent": percent, "stat": bits.join("  ") }),
    );
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("dl://event", payload);
}

/* --------------------------------------------------------------------- */
/* Entry point                                                            */
/* --------------------------------------------------------------------- */
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            // Extract the bundled engine eagerly on launch (the macOS
            // equivalent of install-time), so the first download is instant.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = ensure_engine(&handle) {
                    eprintln!("engine setup failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_dependencies,
            default_download_dir,
            fetch_info,
            start_download,
            cancel_download,
            reset_cookies,
            update_engine,
            cached_avatar,
            refresh_avatar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
