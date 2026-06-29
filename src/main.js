import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { load } from "@tauri-apps/plugin-store";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

const $ = (id) => document.getElementById(id);

/* ================================================================== */
/* Persistent store                                                   */
/* ================================================================== */
let store = null;
async function initStore() {
  try { store = await load("settings.json", { autoSave: true }); } catch (e) { console.error("store:", e); }
}
async function saveSetting(key, val) {
  if (!store) return;
  try { await store.set(key, val); } catch (e) { console.error(e); }
}
async function getSetting(key) {
  if (!store) return undefined;
  try { return await store.get(key); } catch { return undefined; }
}

/* ================================================================== */
/* Advanced config model (global defaults vs per-download)            */
/* ================================================================== */
// Every "global-able" advanced field with its default. Booleans -> switches.
const GLOBAL_FIELDS = {
  "opt-mode": "video",
  "opt-quality": "0",
  "opt-container": "mp4",
  "opt-audio-format": "mp3",
  "opt-audio-quality": "0",
  "opt-codec": "",
  "opt-fps": false,
  "opt-outdir": "",
  "opt-template": "%(title)s.%(ext)s",
  "opt-ratelimit": "",
  "opt-fragments": "1",
  "opt-ipv4": false,
  "opt-bypass": false,
  "opt-playlist": false,
  "opt-thumbnail": true,
  "opt-metadata": true,
  "opt-chapters": false,
  "opt-subs": false,
  "opt-autosubs": false,
  "opt-sponsorblock": false,
  "opt-subslang": "en",
  "opt-extra": "",
  "opt-archive": false,
  "opt-split": false,
};
const isCheck = (id) => typeof GLOBAL_FIELDS[id] === "boolean";

let globalCfg = { ...GLOBAL_FIELDS };
let sessionCfg = { ...GLOBAL_FIELDS };
let scope = "download"; // "download" | "global"
const activeCfg = () => (scope === "global" ? globalCfg : sessionCfg);

function applyCfgToForm(cfg) {
  for (const id of Object.keys(GLOBAL_FIELDS)) {
    const el = $(id);
    if (!el) continue;
    if (isCheck(id)) el.checked = !!cfg[id];
    else el.value = cfg[id] ?? "";
  }
}
async function persistGlobal() { await saveSetting("global_defaults", globalCfg); }

// Live-bind every field to the active cfg.
function wireFields() {
  for (const id of Object.keys(GLOBAL_FIELDS)) {
    const el = $(id);
    if (!el) continue;
    const ev = isCheck(id) || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(ev, () => {
      activeCfg()[id] = isCheck(id) ? el.checked : el.value;
      if (scope === "global") persistGlobal();
      if (id === "opt-mode") { syncModeFields(); clearPresetActive(); }
    });
  }
}

/* ================================================================== */
/* Normal / Advanced tabs + scope toggle                              */
/* ================================================================== */
document.querySelectorAll("#dq-tabs .tab").forEach((t) =>
  t.addEventListener("click", () => switchQ(t.dataset.q))
);
function switchQ(q) {
  document.querySelectorAll("#dq-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.q === q));
  document.querySelectorAll("[data-qpane]").forEach((p) => p.classList.toggle("hidden", p.dataset.qpane !== q));
}

document.querySelectorAll("#scope-seg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => setScope(b.dataset.scope))
);
function setScope(s) {
  scope = s;
  document.querySelectorAll("#scope-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.scope === s));
  applyCfgToForm(activeCfg());
  document.querySelectorAll(".per-video").forEach((e) => e.classList.toggle("hidden", s !== "download"));
  $("scope-hint").textContent =
    s === "global"
      ? "Editing global defaults — saved for every future download."
      : "Tweaks apply to the next download only.";
  syncModeFields();
}

/* ================================================================== */
/* Presets (built-in + custom)                                        */
/* ================================================================== */
const PRESETS = [
  { id: "best", title: "Best Quality", desc: "Top video + audio, mp4", cfg: { "opt-mode": "video", "opt-quality": "0", "opt-container": "mp4" } },
  { id: "1080", title: "1080p MP4", desc: "Full HD, compatible", cfg: { "opt-mode": "video", "opt-quality": "1080", "opt-container": "mp4" } },
  { id: "720", title: "720p MP4", desc: "Smaller file, HD", cfg: { "opt-mode": "video", "opt-quality": "720", "opt-container": "mp4" } },
  { id: "mkv", title: "Best (MKV)", desc: "No loss, any codec", cfg: { "opt-mode": "video", "opt-quality": "0", "opt-container": "mkv" } },
  { id: "mp3", title: "MP3 Audio", desc: "Universal audio", cfg: { "opt-mode": "audio", "opt-audio-format": "mp3", "opt-audio-quality": "0" } },
  { id: "m4a", title: "M4A Audio", desc: "Best AAC, no re-encode", cfg: { "opt-mode": "audio", "opt-audio-format": "m4a", "opt-audio-quality": "0" } },
  { id: "flac", title: "FLAC Audio", desc: "Lossless", cfg: { "opt-mode": "audio", "opt-audio-format": "flac", "opt-audio-quality": "0" } },
  { id: "opus", title: "Opus Audio", desc: "Efficient, high quality", cfg: { "opt-mode": "audio", "opt-audio-format": "opus", "opt-audio-quality": "0" } },
];
let customPresets = [];

function renderPresets() {
  const wrap = $("presets");
  wrap.innerHTML = "";
  for (const p of PRESETS) {
    wrap.appendChild(makePresetEl(p.id, p.title, p.desc, p.cfg, false));
  }
  for (const c of customPresets) {
    wrap.appendChild(makePresetEl(c.id, c.name, "Custom", c.cfg, true));
  }
}
function makePresetEl(id, title, desc, cfg, custom) {
  const el = document.createElement("button");
  el.className = "preset";
  el.dataset.id = id;
  el.innerHTML = `<div class="p-title">${escapeHtml(title)}</div><div class="p-desc">${escapeHtml(desc)}</div>`;
  el.addEventListener("click", () => applyPresetCfg(cfg, id));
  if (custom) {
    const del = document.createElement("button");
    del.className = "preset-del";
    del.textContent = "✕";
    del.title = "Delete preset";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteCustomPreset(id); });
    el.appendChild(del);
  }
  return el;
}
function applyPresetCfg(partial, id) {
  const cfg = activeCfg();
  for (const [k, v] of Object.entries(partial)) {
    if (k in GLOBAL_FIELDS) cfg[k] = v;
  }
  applyCfgToForm(cfg);
  if (scope === "global") persistGlobal();
  document.querySelectorAll(".preset").forEach((e) => e.classList.toggle("active", e.dataset.id === id));
  syncModeFields();
}
function clearPresetActive() {
  document.querySelectorAll(".preset").forEach((e) => e.classList.remove("active"));
}
async function saveAsPreset() {
  const name = $("preset-name").value.trim();
  if (!name) { $("preset-name").focus(); return; }
  const snapshot = {};
  for (const id of Object.keys(GLOBAL_FIELDS)) snapshot[id] = activeCfg()[id];
  customPresets.push({ id: crypto.randomUUID(), name, cfg: snapshot });
  await saveSetting("custom_presets", customPresets);
  $("preset-name").value = "";
  renderPresets();
}
async function deleteCustomPreset(id) {
  customPresets = customPresets.filter((c) => c.id !== id);
  await saveSetting("custom_presets", customPresets);
  renderPresets();
}
$("btn-save-preset").addEventListener("click", saveAsPreset);
$("btn-reset-global").addEventListener("click", () => {
  sessionCfg = { ...globalCfg };
  if (scope === "download") applyCfgToForm(sessionCfg);
  // clear per-video fields too
  resetFormats();
  $("opt-trim").checked = false;
  $("trim-controls").classList.add("hidden");
  $("opt-clip-start").value = "";
  $("opt-clip-end").value = "";
  $("opt-plitems").value = "";
  clearPresetActive();
  syncModeFields();
});

/* ================================================================== */
/* View switching (app bar) + downloads tabs + theme                  */
/* ================================================================== */
function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  document.querySelectorAll(".appbar-btn").forEach((n) => n.classList.toggle("active", n.dataset.nav === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll("[data-nav]").forEach((n) => n.addEventListener("click", () => switchView(n.dataset.nav)));

function switchTab(tab) {
  document.querySelectorAll("#dl-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab));
}
document.querySelectorAll("#dl-tabs .tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

const THEME_KEY = "theme";
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.classList.toggle("active", b.dataset.themeChoice === mode));
}
document.querySelectorAll("[data-theme-choice]").forEach((b) =>
  b.addEventListener("click", () => { applyTheme(b.dataset.themeChoice); saveSetting(THEME_KEY, b.dataset.themeChoice); })
);

function syncModeFields() {
  const mode = $("opt-mode").value;
  document.querySelectorAll("[data-mode]").forEach((el) => {
    el.style.display = el.dataset.mode === mode ? "" : "none";
  });
}

/* ================================================================== */
/* Folder pickers / cookies / IPv4 default                            */
/* ================================================================== */
$("btn-browse").addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (!dir) return;
  $("opt-outdir").value = dir;
  activeCfg()["opt-outdir"] = dir;
  if (scope === "global") { $("set-outdir").value = dir; persistGlobal(); }
});
$("btn-browse-default").addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (!dir) return;
  globalCfg["opt-outdir"] = dir;
  $("set-outdir").value = dir;
  if (scope === "global") $("opt-outdir").value = dir;
  persistGlobal();
});

// Open external links (about / developer).
document.querySelectorAll("[data-open]").forEach((b) =>
  b.addEventListener("click", () => openUrl(b.dataset.open).catch((e) => console.error(e)))
);

// Self-update the yt-dlp engine to the latest release.
$("btn-update-engine").addEventListener("click", async () => {
  const btn = $("btn-update-engine");
  const status = $("update-status");
  btn.disabled = true;
  btn.textContent = "Updating…";
  status.textContent = "Checking for the latest yt-dlp…";
  try {
    const tag = await invoke("update_engine");
    status.textContent = `On latest: ${tag}`;
    await checkDeps();
  } catch (e) {
    status.textContent = "Update failed — check your connection.";
    console.error(e);
  } finally {
    btn.textContent = "Update engine";
    btn.disabled = false;
  }
});

$("btn-reset-cookies").addEventListener("click", async () => {
  const btn = $("btn-reset-cookies");
  btn.disabled = true;
  try { await invoke("reset_cookies"); btn.textContent = "Cookies reset ✓"; }
  catch (e) { btn.textContent = "Reset failed"; console.error(e); }
  finally { setTimeout(() => { btn.textContent = "Reset cookies"; btn.disabled = false; }, 1800); }
});

/* ================================================================== */
/* Dependency check                                                   */
/* ================================================================== */
let depsOk = false;
async function checkDeps() {
  try {
    const deps = await invoke("check_dependencies");
    setDep("engine", deps.ytdlp, "bundled", "Bundled yt-dlp not found");
    setDep("ffmpeg", deps.ffmpeg, "Installed", "Not found — needed for HD merge & audio convert");
    depsOk = !!deps.ytdlp;
    updateDownloadEnabled();
  } catch (e) { console.error(e); }
}
function setDep(key, version, okLabel, badLabel) {
  const ok = !!version;
  $(`set-${key}`).textContent = ok ? `${okLabel} · ${version}` : badLabel;
  const dot = $(`dot-${key}`);
  dot.classList.toggle("ok", ok);
  dot.classList.toggle("bad", !ok);
}

/* ================================================================== */
/* Fetch info + format picker + clip slider                           */
/* ================================================================== */
let lastMeta = null;
let fetchedOk = false;
let fetchTimer = null;
let batchMode = false;
let clipDur = 0;

function metaSub(info) {
  const bits = [];
  if (info.uploader) bits.push(info.uploader);
  if (info.duration) bits.push(formatDuration(info.duration));
  if (info.is_playlist) bits.push(`Playlist · ${info.count} items`);
  return bits.join("  ·  ");
}
function updateDownloadEnabled() {
  $("btn-download").disabled = !(depsOk && (fetchedOk || batchMode));
}
function parseUrls(text) {
  return text.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

function populateFormats(formats) {
  const sel = $("opt-format");
  sel.innerHTML = '<option value="">Auto — use quality above</option>';
  for (const f of formats || []) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.label;
    sel.appendChild(o);
  }
}
function resetFormats() {
  $("opt-format").innerHTML = '<option value="">Auto — use quality above</option>';
}

function renderMeta(info) {
  const meta = $("meta");
  meta.classList.remove("hidden");
  $("meta-thumb").src = info.thumbnail || "";
  $("meta-thumb").style.display = info.thumbnail ? "" : "none";
  $("meta-title").textContent = info.title || "(untitled)";
  $("meta-sub").textContent = metaSub(info);
  if (info.is_playlist) $("opt-playlist").checked = true;
  populateFormats(info.formats || []);
  setClipDuration(info.is_playlist ? 0 : info.duration || 0);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out — the link may be slow or unavailable.")), ms)),
  ]);
}
async function autoFetch(url) {
  const meta = $("meta");
  meta.classList.remove("hidden");
  $("meta-thumb").style.display = "none";
  $("meta-title").textContent = "Fetching info…";
  $("meta-sub").textContent = url;
  try {
    const info = await withTimeout(invoke("fetch_info", { url }), 30000);
    if ($("url").value.trim() !== url) return;
    lastMeta = { url, ...info };
    renderMeta(info);
    fetchedOk = true;
  } catch (e) {
    if ($("url").value.trim() !== url) return;
    $("meta-thumb").style.display = "none";
    $("meta-title").textContent = "Could not fetch info";
    $("meta-sub").textContent = String(e);
    fetchedOk = false;
    setClipDuration(0);
  } finally {
    updateDownloadEnabled();
  }
}

$("url").addEventListener("input", () => {
  const raw = $("url").value;
  const urls = parseUrls(raw);
  clearTimeout(fetchTimer);
  fetchedOk = false;
  batchMode = urls.length > 1;
  resetFormats();
  if (batchMode) {
    const meta = $("meta");
    meta.classList.remove("hidden");
    $("meta-thumb").style.display = "none";
    $("meta-title").textContent = `${urls.length} links queued`;
    $("meta-sub").textContent = "Batch mode — each downloads with the options below.";
    setClipDuration(0);
    updateDownloadEnabled();
    return;
  }
  updateDownloadEnabled();
  const url = urls[0] || raw.trim();
  if (!url) { $("meta").classList.add("hidden"); setClipDuration(0); return; }
  fetchTimer = setTimeout(() => autoFetch(url), 600);
});

/* ---- clip slider ---- */
function setClipDuration(sec) {
  clipDur = Math.max(0, Math.round(sec || 0));
  const slider = $("trim-slider");
  if (clipDur > 0) {
    slider.classList.remove("hidden");
    $("rs-start").max = clipDur; $("rs-end").max = clipDur;
    $("rs-start").value = 0; $("rs-end").value = clipDur;
    $("opt-clip-start").value = "";
    $("opt-clip-end").value = "";
    $("trim-hint").textContent = "Drag the handles, or type times below.";
    updateClipFill();
  } else {
    slider.classList.add("hidden");
    $("trim-hint").textContent = "Enter start/end times manually (mm:ss).";
  }
}
function updateClipFill() {
  const max = clipDur || 1;
  const s = +$("rs-start").value, e = +$("rs-end").value;
  $("rs-fill").style.left = (s / max) * 100 + "%";
  $("rs-fill").style.width = ((e - s) / max) * 100 + "%";
}
function writeClipFields() {
  $("opt-clip-start").value = clock(+$("rs-start").value);
  $("opt-clip-end").value = clock(+$("rs-end").value);
  updateClipFill();
}
$("rs-start").addEventListener("input", () => {
  let s = +$("rs-start").value, e = +$("rs-end").value;
  if (s > e) { s = e; $("rs-start").value = s; }
  writeClipFields();
});
$("rs-end").addEventListener("input", () => {
  let s = +$("rs-start").value, e = +$("rs-end").value;
  if (e < s) { e = s; $("rs-end").value = e; }
  writeClipFields();
});
["opt-clip-start", "opt-clip-end"].forEach((id) =>
  $(id).addEventListener("input", () => {
    if (!clipDur) return;
    const ss = parseClock($("opt-clip-start").value);
    const ee = parseClock($("opt-clip-end").value);
    if (ss != null) $("rs-start").value = Math.min(ss, clipDur);
    if (ee != null) $("rs-end").value = Math.min(ee, clipDur);
    updateClipFill();
  })
);
$("opt-trim").addEventListener("change", () => {
  $("trim-controls").classList.toggle("hidden", !$("opt-trim").checked);
});

/* ================================================================== */
/* Download                                                           */
/* ================================================================== */
const jobs = new Map();

function cfgToBackend(cfg) {
  return {
    mode: cfg["opt-mode"],
    quality: cfg["opt-quality"],
    container: cfg["opt-container"],
    audio_format: cfg["opt-audio-format"],
    audio_quality: cfg["opt-audio-quality"],
    output_dir: cfg["opt-outdir"] || null,
    template: cfg["opt-template"] || "%(title)s.%(ext)s",
    rate_limit: cfg["opt-ratelimit"] || null,
    force_ipv4: !!cfg["opt-ipv4"],
    concurrent_fragments: cfg["opt-fragments"] || "1",
    bypass_throttle: !!cfg["opt-bypass"],
    playlist: !!cfg["opt-playlist"],
    embed_thumbnail: !!cfg["opt-thumbnail"],
    embed_metadata: !!cfg["opt-metadata"],
    embed_chapters: !!cfg["opt-chapters"],
    subtitles: !!cfg["opt-subs"],
    auto_subs: !!cfg["opt-autosubs"],
    sponsorblock: !!cfg["opt-sponsorblock"],
    subs_lang: cfg["opt-subslang"] || "en",
    extra_args: cfg["opt-extra"] || null,
    prefer_codec: cfg["opt-codec"] || "",
    prefer_fps: !!cfg["opt-fps"],
    archive: !!cfg["opt-archive"],
    split_chapters: !!cfg["opt-split"],
  };
}
function collectOptions() {
  const o = cfgToBackend(sessionCfg);
  o.format_id = $("opt-format").value || "";
  const trim = $("opt-trim").checked;
  o.section_start = trim ? $("opt-clip-start").value.trim() : "";
  o.section_end = trim ? $("opt-clip-end").value.trim() : "";
  o.playlist_items = $("opt-plitems").value.trim();
  return o;
}

$("btn-download").addEventListener("click", async () => {
  const raw = $("url").value;
  const urls = parseUrls(raw);
  const list = urls.length > 0 ? urls : [raw.trim()].filter(Boolean);
  if (list.length === 0) { $("url").focus(); return; }
  const opts = collectOptions();
  switchView("downloads");
  switchTab("active");
  for (const u of list) {
    const id = crypto.randomUUID();
    const meta = !batchMode && lastMeta && lastMeta.url === u ? lastMeta : null;
    createJob(id, u, meta);
    if (!meta) enrichJob(id, u);
    invoke("start_download", { id, url: u, opts }).catch((e) => updateJob(id, { status: "error", log: String(e) }));
  }
});

async function enrichJob(id, url) {
  try {
    const info = await invoke("fetch_info", { url });
    if (lastMeta == null) lastMeta = { url, ...info };
    updateJob(id, { title: info.title, sub: metaSub(info), thumbnail: info.thumbnail });
  } catch { /* keep url fallback */ }
}

function createJob(id, url, meta) {
  const wrap = $("jobs-active");
  const el = document.createElement("div");
  el.className = "job";
  el.id = `job-${id}`;
  const title = meta?.title || url;
  const sub = meta ? metaSub(meta) : url;
  const thumb = meta?.thumbnail || "";
  el.innerHTML = `
    <div class="job-head">
      <img class="job-thumb${thumb ? "" : " hidden"}" src="${thumb}" alt="" />
      <div class="job-headinfo">
        <div class="job-title">${escapeHtml(title)}</div>
        <div class="job-sub">${escapeHtml(sub)}</div>
      </div>
      <span class="job-status s-running">starting</span>
    </div>
    <div class="bar"><div class="bar-fill"></div></div>
    <div class="job-meta">
      <span class="job-stat">—</span>
      <div class="job-actions">
        <button class="chip log-btn">Log</button>
        <button class="chip cancel-btn">Cancel</button>
      </div>
    </div>
    <div class="job-log"></div>`;
  wrap.prepend(el);
  el.querySelector(".log-btn").addEventListener("click", () => el.querySelector(".job-log").classList.toggle("open"));
  el.querySelector(".cancel-btn").addEventListener("click", () => invoke("cancel_download", { id }).catch(() => {}));
  jobs.set(id, { el, log: "", done: false });
  updateCounts();
}

function updateJob(id, data) {
  const job = jobs.get(id);
  if (!job) return;
  const el = job.el;
  if (data.percent !== undefined) el.querySelector(".bar-fill").style.width = `${data.percent}%`;
  if (data.stat !== undefined) el.querySelector(".job-stat").textContent = data.stat;
  if (data.title) el.querySelector(".job-title").textContent = data.title;
  if (data.sub) el.querySelector(".job-sub").textContent = data.sub;
  if (data.thumbnail) {
    const t = el.querySelector(".job-thumb");
    t.src = data.thumbnail;
    t.classList.remove("hidden");
  }
  if (data.log) {
    job.log += data.log + "\n";
    const logEl = el.querySelector(".job-log");
    logEl.textContent = job.log;
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (data.status) {
    const s = el.querySelector(".job-status");
    s.className = "job-status " + ({ running: "s-running", done: "s-done", error: "s-error", canceled: "s-canceled" }[data.status] || "s-running");
    s.textContent = data.status;
    if (["done", "error", "canceled"].includes(data.status)) {
      job.done = true;
      el.querySelector(".cancel-btn")?.remove();
      if (data.status === "done" && data.filepath) {
        const reveal = document.createElement("button");
        reveal.className = "chip chip--solid";
        reveal.textContent = "Show in folder";
        reveal.addEventListener("click", () => revealItemInDir(data.filepath).catch(() => {}));
        el.querySelector(".job-actions").prepend(reveal);
      }
      $("jobs-done").prepend(el);
      if (data.status === "done") notifyDone(el.querySelector(".job-title").textContent);
      updateCounts();
    }
  }
}

function updateCounts() {
  const arr = [...jobs.values()];
  const active = arr.filter((j) => !j.done).length;
  const done = arr.length - active;
  const pill = $("dl-count");
  pill.textContent = String(active);
  pill.classList.toggle("hidden", active === 0);
  $("tab-active-count").textContent = String(active);
  $("tab-done-count").textContent = String(done);
  $("active-empty").classList.toggle("hidden", active > 0);
  $("done-empty").classList.toggle("hidden", done > 0);
}

$("btn-clear").addEventListener("click", () => {
  for (const [id, job] of jobs) {
    if (job.done) { job.el.remove(); jobs.delete(id); }
  }
  updateCounts();
});

listen("dl://event", (event) => updateJob(event.payload.id, event.payload));

/* ================================================================== */
/* Desktop notifications                                              */
/* ================================================================== */
let notifyOk = false;
async function initNotifications() {
  try {
    notifyOk = await isPermissionGranted();
    if (!notifyOk) notifyOk = (await requestPermission()) === "granted";
  } catch (e) { console.error(e); }
}
function notifyDone(title) {
  if (!notifyOk) return;
  try { sendNotification({ title: "Download complete", body: title }); } catch {}
}

/* ================================================================== */
/* Helpers                                                            */
/* ================================================================== */
function formatDuration(sec) {
  return clock(sec);
}
function clock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function parseClock(str) {
  str = (str || "").trim();
  if (!str) return null;
  const parts = str.split(":").map((x) => Number(x));
  if (parts.some((x) => Number.isNaN(x))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ================================================================== */
/* Init                                                               */
/* ================================================================== */
$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("btn-download").disabled) $("btn-download").click();
});

async function init() {
  await initStore();

  // Default output folder (only if no saved global value).
  let defaultDir = "";
  try { defaultDir = await invoke("default_download_dir"); } catch {}

  const savedGlobal = await getSetting("global_defaults");
  globalCfg = { ...GLOBAL_FIELDS, ...(savedGlobal || {}) };
  if (!globalCfg["opt-outdir"]) globalCfg["opt-outdir"] = defaultDir;
  sessionCfg = { ...globalCfg };

  customPresets = (await getSetting("custom_presets")) || [];

  applyCfgToForm(sessionCfg); // start in per-download scope
  $("set-outdir").value = globalCfg["opt-outdir"] || defaultDir;

  renderPresets();
  wireFields();
  syncModeFields();
  setScope("download");
  setClipDuration(0);
  updateCounts();

  applyTheme((await getSetting(THEME_KEY)) || "system");
  checkDeps();
  initNotifications();
  loadAvatar();
}
init();

/* ------------------------------------------------------------------ */
/* Developer avatar — show cached (offline-ok), refresh when online   */
/* ------------------------------------------------------------------ */
const DEV_GITHUB = "tabhishekpaul";
async function loadAvatar() {
  const img = $("dev-avatar");
  try {
    const cached = await invoke("cached_avatar");
    if (cached) img.src = cached;
  } catch {}
  try {
    const fresh = await invoke("refresh_avatar", { username: DEV_GITHUB });
    if (fresh) img.src = fresh;
  } catch { /* offline — keep cached */ }
}
