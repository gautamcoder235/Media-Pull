// Safely evaluate Tauri globals dynamically to avoid script load failures if run in browser or before injection is complete
async function invoke(cmd, args) {
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  console.warn(`Tauri backend not available. Mocking/Ignoring command: ${cmd}`, args);
  // Return placeholder values for local development fallback
  if (cmd === "load_app_settings") {
    return { ffmpeg_path: "C:\\ffmpeg\\bin", ytdlp_path: "", current_theme: "Tokyo Night" };
  }
  return null;
}

async function listen(event, handler) {
  if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
    return await window.__TAURI__.event.listen(event, handler);
  }
  console.warn(`Tauri backend not available. Ignoring event listener for: ${event}`);
  return () => {};
}


// Active application settings in memory
let appSettings = {
  ffmpeg_path: "C:\\ffmpeg\\bin",
  ytdlp_path: "",
  current_theme: "Tokyo Night"
};

// Memory cache for fetched video information to enable "Instant Reload"
const metadataCache = new Map();
const videoOnlyIds = new Set();

// Helper to get cookies parameter for backend based on selected UI source
function getCookiesParam() {
  const source = document.getElementById("select-cookies-source").value;
  if (source === "none") {
    return null;
  } else if (source === "file") {
    return document.getElementById("cookies-path").value || null;
  } else {
    // browser source
    return `browser:${source}`;
  }
}

// Helper to log to collapsible action console
function logToConsole(message, type = "info") {
  const consoleBox = document.getElementById("console-log");
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
  consoleBox.textContent += line;
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

// Map human theme labels / settings strings to exact CSS theme classes
function normalizeThemeId(theme) {
  const map = {
    "tokyonight": "tokyonight",
    "tokyo night": "tokyonight",
    "dracula": "dracula",
    "nord": "nord",
    "cyberpunk": "cyberpunk",
    "neon cyberpunk": "cyberpunk",
    "gruvbox": "gruvbox",
    "gruvbox dark": "gruvbox",
    "pastel": "pastel",
    "soft pastel": "pastel",
    "sakura": "sakura",
    "sakura pink": "sakura",
    "monochrome": "monochrome"
  };
  const normalized = theme.toLowerCase().trim();
  return map[normalized] || normalized.replace(/\s+/g, "");
}

// Switch CSS themes dynamically
function applyTheme(themeName) {
  const themeId = normalizeThemeId(themeName);
  
  // Remove existing themes
  const classes = Array.from(document.body.classList);
  classes.forEach(c => {
    if (c.startsWith("theme-")) {
      document.body.classList.remove(c);
    }
  });

  // Apply new theme
  const className = `theme-${themeId}`;
  document.body.classList.add(className);
  appSettings.current_theme = themeName;
  
  // Update Theme Cards Active State
  document.querySelectorAll(".theme-card").forEach(card => {
    if (card.dataset.theme === themeId) {
      card.classList.add("active");
    } else {
      card.classList.remove("active");
    }
  });

  logToConsole(`Theme updated to: ${themeName} (class: ${className})`);
}

// Load settings from backend
async function loadSettings() {
  try {
    const settings = await invoke("load_app_settings");
    if (settings) {
      appSettings = { ...appSettings, ...settings };
      applyTheme(appSettings.current_theme);
      
      // Update inputs
      document.getElementById("settings-ffmpeg").value = appSettings.ffmpeg_path;
      document.getElementById("settings-ytdlp").value = appSettings.ytdlp_path;
      
      // Auto verify paths on startup (perceived speed: validation happens in bg immediately)
      if (appSettings.ffmpeg_path) {
        verifyBinaryPath(appSettings.ffmpeg_path, "ffmpeg", "badge-ffmpeg", "version-ffmpeg");
      }
      if (appSettings.ytdlp_path) {
        verifyBinaryPath(appSettings.ytdlp_path, "yt-dlp", "badge-ytdlp", "version-ytdlp");
      }
    }
  } catch (err) {
    logToConsole(`Failed to load settings: ${err}`, "error");
  }
}

// Save settings to backend
async function saveSettings() {
  try {
    await invoke("save_app_settings", { settings: appSettings });
    logToConsole("Settings saved successfully.");
  } catch (err) {
    logToConsole(`Failed to save settings: ${err}`, "error");
  }
}

// Verify ffmpeg or yt-dlp binary path
async function verifyBinaryPath(path, name, badgeId, versionId) {
  const badge = document.getElementById(badgeId);
  const versionEl = document.getElementById(versionId);
  
  badge.className = "verify-badge unverified";
  badge.innerHTML = "<span>●</span> Verifying...";
  versionEl.textContent = "";

  try {
    const version = await invoke("verify_binary", { path, name });
    badge.className = "verify-badge success";
    badge.innerHTML = "<span>✓</span> Verified";
    versionEl.textContent = version;
    logToConsole(`${name} verified: ${version}`);
    return true;
  } catch (err) {
    badge.className = "verify-badge error";
    badge.innerHTML = "<span>❌</span> Failed";
    versionEl.textContent = "Not found or execution failed.";
    logToConsole(`Verification failed for ${name} at ${path}: ${err}`, "warning");
    return false;
  }
}

// Initialize navigation
function initNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".page");
  
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      const targetPageId = item.dataset.target;
      
      navItems.forEach(btn => btn.classList.remove("active"));
      pages.forEach(page => page.classList.remove("active"));
      
      item.classList.add("active");
      const targetPage = document.getElementById(targetPageId);
      targetPage.classList.add("active");
      
      logToConsole(`Navigated to: ${item.querySelector("span").textContent}`);
    });
  });
}

// Helper to format duration seconds to MM:SS
function formatDuration(seconds) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// Helper to format file sizes
function formatBytes(bytes) {
  if (!bytes) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Populate video format options in dropdown select elements
function populateFormats(formats) {
  const progSelect = document.getElementById("select-progressive");
  const videoSelect = document.getElementById("select-video-only");
  const audioSelect = document.getElementById("select-audio-only");
  
  progSelect.innerHTML = "";
  videoSelect.innerHTML = "";
  audioSelect.innerHTML = "";
  
  videoOnlyIds.clear();
  
  const videoWithAudioList = [];
  const videoOnlyList = [];
  const audioOnlyList = [];
  
  formats.forEach(f => {
    const fmtId = f.format_id || f.id || "";
    const ext = f.ext || "";
    const resolution = f.resolution || (f.height ? `${f.height}p` : null) || f.format_note || null;
    const vcodec = f.vcodec || "none";
    const acodec = f.acodec || "none";
    const abr = f.abr || 0;
    const size = f.filesize || f.filesize_approx || 0;
    
    // Label descriptor
    const labelParts = [];
    if (resolution) labelParts.push(resolution);
    if (vcodec !== "none") labelParts.push(vcodec);
    if (acodec !== "none") {
      labelParts.push("audio");
      if (abr) labelParts.push(`${Math.round(abr)}kbps`);
    }
    const sizeLabel = size ? `(${formatBytes(size)})` : "";
    const label = `${fmtId} — ${ext} [${labelParts.join(", ")}] ${sizeLabel}`;
    
    const item = { id: fmtId, label, resolution, size, height: f.height || 0, abr };
    
    if (vcodec !== "none") {
      // All video formats (progressive and video-only) go to the first dropdown!
      videoWithAudioList.push(item);
      
      // Only video-only formats go to the second dropdown
      if (acodec === "none") {
        videoOnlyList.push(item);
        videoOnlyIds.add(fmtId);
      }
    } else if (acodec !== "none") {
      audioOnlyList.push(item);
    }
  });
  
  // Sort formats
  videoWithAudioList.sort((a, b) => (b.height - a.height) || (b.size - a.size));
  videoOnlyList.sort((a, b) => (b.height - a.height) || (b.size - a.size));
  audioOnlyList.sort((a, b) => (b.abr - a.abr) || (b.size - a.size));
  
  // Helper to add options
  const addOptions = (select, list) => {
    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(none)";
      select.appendChild(opt);
      select.disabled = true;
    } else {
      select.disabled = false;
      list.forEach(item => {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.textContent = item.label;
        select.appendChild(opt);
      });
    }
  };
  
  addOptions(progSelect, videoWithAudioList);
  addOptions(videoSelect, videoOnlyList);
  addOptions(audioSelect, audioOnlyList);
}

// Fetch Video Info
async function fetchVideoInfo() {
  const url = document.getElementById("video-url").value.trim();
  if (!url) {
    alert("Please enter a valid video link.");
    return;
  }
  
  const dashboard = document.getElementById("downloader-dashboard");
  const skeleton = document.getElementById("preview-skeleton");
  const previewContent = document.getElementById("preview-content");
  
  dashboard.style.display = "grid";
  skeleton.style.display = "block";
  previewContent.style.display = "none";
  
  // Check memory cache first (Perceived speed: instant load)
  if (metadataCache.has(url)) {
    logToConsole(`Cache HIT: Instantly loading metadata for ${url}`);
    const metadata = metadataCache.get(url);
    displayVideoMetadata(metadata);
    return;
  }
  
  logToConsole(`Cache MISS: Fetching metadata for ${url}`);
  const cookiesPath = getCookiesParam();
  const ytdlpPath = appSettings.ytdlp_path || null;
  
  try {
    const rawJson = await invoke("fetch_video_metadata", { url, cookiesPath, ytdlpPath });
    const metadata = JSON.parse(rawJson);
    
    // Save to Cache
    metadataCache.set(url, metadata);
    if (metadataCache.size > 10) {
      // Evict oldest
      const firstKey = metadataCache.keys().next().value;
      metadataCache.delete(firstKey);
    }
    
    displayVideoMetadata(metadata);
  } catch (err) {
    dashboard.style.display = "none";
    logToConsole(`Failed to fetch metadata: ${err}`, "error");
    if (err.toString().includes("Could not copy") && err.toString().includes("cookie database")) {
      alert(`Failed to fetch metadata:\n\nYour selected browser's cookies database is currently locked because the browser is open.\n\nPlease CLOSE the browser completely (or use the custom cookies.txt method) and try again!`);
    } else {
      alert(`Failed to fetch metadata:\n${err}`);
    }
  }
}

// Display Video Info in UI
function displayVideoMetadata(metadata) {
  const skeleton = document.getElementById("preview-skeleton");
  const previewContent = document.getElementById("preview-content");
  
  skeleton.style.display = "none";
  previewContent.style.display = "block";
  
  document.getElementById("video-thumbnail").src = metadata.thumbnail || "";
  document.getElementById("video-title").textContent = metadata.title || "—";
  document.getElementById("video-uploader").textContent = metadata.uploader || "—";
  document.getElementById("video-duration").textContent = formatDuration(metadata.duration);
  document.getElementById("video-views").textContent = metadata.view_count ? metadata.view_count.toLocaleString() : "—";
  
  populateFormats(metadata.formats || []);
  logToConsole("Metadata loaded and formats populated.");
}

// Toggle console log collapsing
function initConsoleToggle() {
  const header = document.getElementById("console-header");
  const box = document.getElementById("console-log");
  const arrow = document.getElementById("console-arrow");
  
  header.addEventListener("click", () => {
    box.classList.toggle("collapsed");
    arrow.textContent = box.classList.contains("collapsed") ? "▲" : "▼";
  });
}

// Global listen references to unlisten progress
let progressUnlisten = null;
let finishedUnlisten = null;

// Throttling progress events to avoid blocking UI thread
let lastProgressTime = 0;
const PROGRESS_THROTTLE_MS = 100; // 10 updates per second

// Setup Tauri event listeners for download progress
async function setupDownloadListeners() {
  if (progressUnlisten) progressUnlisten();
  if (finishedUnlisten) finishedUnlisten();
  
  progressUnlisten = await listen("download-progress", (event) => {
    const payload = event.payload;
    const now = Date.now();
    
    // Update progress bar and numerical percent instantly (always visual responsiveness)
    document.getElementById("progress-bar-fill").style.width = `${payload.percent}%`;
    document.getElementById("progress-percent-lbl").textContent = `${Math.round(payload.percent)}%`;
    document.getElementById("progress-status-text").textContent = payload.status_text;

    // Throttle textual label redraws to maintain 60 FPS UI fluidness
    if (now - lastProgressTime > PROGRESS_THROTTLE_MS || payload.percent >= 100) {
      document.getElementById("progress-downloaded").textContent = `Downloaded: ${payload.total_size ? payload.total_size : '—'}`;
      document.getElementById("progress-speed").textContent = `Speed: ${payload.speed ? payload.speed : '0B/s'}`;
      document.getElementById("progress-eta").textContent = `ETA: ${payload.eta ? payload.eta : '--:--'}`;
      lastProgressTime = now;
    }
  });
  
  finishedUnlisten = await listen("download-finished", (event) => {
    const payload = event.payload;
    document.getElementById("progress-status-text").textContent = payload.status_text;
    logToConsole(payload.status_text);
    
    // Re-enable controls
    setDownloadButtonsState(false);
  });
}

// Set loading states on buttons
function setDownloadButtonsState(downloading) {
  const buttons = [
    document.getElementById("btn-dl-progressive"),
    document.getElementById("btn-dl-video"),
    document.getElementById("btn-dl-audio")
  ];
  
  buttons.forEach(btn => btn.disabled = downloading);
  document.getElementById("progress-panel").style.display = downloading ? "block" : "block"; // keep visible to review final completion
  
  if (downloading) {
    document.getElementById("progress-bar-fill").style.width = "0%";
    document.getElementById("progress-percent-lbl").textContent = "0%";
    document.getElementById("progress-status-text").textContent = "Preparing download...";
    document.getElementById("progress-panel").style.display = "block";
    
    // Scroll progress card into view
    document.getElementById("progress-panel").scrollIntoView({ behavior: "smooth" });
  }
}

// Start download
async function startDownload(formatId, convertToMp3 = false) {
  const url = document.getElementById("video-url").value.trim();
  const outFolder = document.getElementById("save-folder").value.trim();
  
  if (!url || !outFolder || !formatId) {
    alert("Incomplete download configuration.");
    return;
  }
  
  setDownloadButtonsState(true);
  logToConsole(`Starting download for format ID: ${formatId} to folder: ${outFolder}`);
  
  const cookiesPath = getCookiesParam();
  const ytdlpPath = appSettings.ytdlp_path || null;
  const ffmpegPath = appSettings.ffmpeg_path || null;
  
  try {
    await invoke("download_media", {
      url,
      outFolder,
      formatId,
      cookiesPath,
      ytdlpPath,
      ffmpegPath,
      convertToMp3
    });
  } catch (err) {
    logToConsole(`Download failed to initiate: ${err}`, "error");
    if (err.toString().includes("Could not copy") && err.toString().includes("cookie database")) {
      alert(`Download failed to start:\n\nYour selected browser's cookies database is currently locked because the browser is open.\n\nPlease CLOSE the browser completely (or use the custom cookies.txt method) and try again!`);
    } else {
      alert(`Download failed to start:\n${err}`);
    }
    setDownloadButtonsState(false);
  }
}

// Cancel active download
async function cancelActiveDownload() {
  try {
    const msg = await invoke("cancel_download");
    logToConsole(msg, "warning");
  } catch (err) {
    logToConsole(`Cancel failed: ${err}`, "error");
  }
}

// Select directories and files using native Rust filedialog
async function initFilePickers() {
  // Folder selector for save folder
  document.getElementById("btn-browse-folder").addEventListener("click", async () => {
    const current = document.getElementById("save-folder").value;
    const res = await invoke("select_folder", { defaultPath: current || null });
    if (res) {
      document.getElementById("save-folder").value = res;
      logToConsole(`Save folder set to: ${res}`);
    }
  });
  
  // Cookies txt selector
  document.getElementById("btn-browse-cookies").addEventListener("click", async () => {
    const res = await invoke("select_file", {
      title: "Select Netscape cookies.txt",
      filterName: "Text Files (*.txt)",
      filterExts: ["txt"]
    });
    if (res) {
      document.getElementById("cookies-path").value = res;
      logToConsole(`Cookies file loaded: ${res}`);
    }
  });
  
  document.getElementById("btn-clear-cookies").addEventListener("click", () => {
    document.getElementById("cookies-path").value = "";
    logToConsole("Cookies file cleared.");
  });

  // Settings: FFmpeg folder selector
  document.getElementById("btn-settings-ffmpeg-browse").addEventListener("click", async () => {
    const current = document.getElementById("settings-ffmpeg").value;
    const res = await invoke("select_folder", { defaultPath: current || null });
    if (res) {
      document.getElementById("settings-ffmpeg").value = res;
      appSettings.ffmpeg_path = res;
      saveSettings();
      verifyBinaryPath(res, "ffmpeg", "badge-ffmpeg", "version-ffmpeg");
    }
  });

  // Settings: FFmpeg automatic downloader
  document.getElementById("btn-settings-ffmpeg-download").addEventListener("click", async () => {
    const btn = document.getElementById("btn-settings-ffmpeg-download");
    const statusEl = document.getElementById("ffmpeg-dl-status");
    
    btn.disabled = true;
    statusEl.textContent = "Initiating installer...";
    logToConsole("Starting automatic FFmpeg downloader...");
    
    try {
      const newPath = await invoke("download_ffmpeg");
      statusEl.textContent = "FFmpeg installation completed!";
      logToConsole(`FFmpeg successfully downloaded and installed at: ${newPath}`);
      
      // Update UI paths
      document.getElementById("settings-ffmpeg").value = newPath;
      appSettings.ffmpeg_path = newPath;
      await saveSettings();
      
      // Verify path immediately
      await verifyBinaryPath(newPath, "ffmpeg", "badge-ffmpeg", "version-ffmpeg");
    } catch (err) {
      statusEl.textContent = "Installation failed.";
      logToConsole(`FFmpeg downloader failed: ${err}`, "error");
      alert(`FFmpeg installation failed:\n${err}`);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-settings-ffmpeg-verify").addEventListener("click", () => {
    const path = document.getElementById("settings-ffmpeg").value;
    verifyBinaryPath(path, "ffmpeg", "badge-ffmpeg", "version-ffmpeg");
  });

  // Settings: yt-dlp exe selector
  document.getElementById("btn-settings-ytdlp-browse").addEventListener("click", async () => {
    const res = await invoke("select_file", {
      title: "Select custom yt-dlp executable",
      filterName: "Executables (*.exe)",
      filterExts: ["exe"]
    });
    if (res) {
      document.getElementById("settings-ytdlp").value = res;
      appSettings.ytdlp_path = res;
      saveSettings();
      verifyBinaryPath(res, "yt-dlp", "badge-ytdlp", "version-ytdlp");
    }
  });

  document.getElementById("btn-settings-ytdlp-verify").addEventListener("click", () => {
    const path = document.getElementById("settings-ytdlp").value;
    verifyBinaryPath(path, "yt-dlp", "badge-ytdlp", "version-ytdlp");
  });

  // Tools: Merge selectors
  document.getElementById("btn-merge-browse-video").addEventListener("click", async () => {
    const res = await invoke("select_file", {
      title: "Select Video File (no audio)",
      filterName: "Video Files",
      filterExts: ["mp4", "mkv", "webm", "avi"]
    });
    if (res) document.getElementById("merge-video").value = res;
  });

  document.getElementById("btn-merge-browse-audio").addEventListener("click", async () => {
    const res = await invoke("select_file", {
      title: "Select Audio File",
      filterName: "Audio Files",
      filterExts: ["m4a", "opus", "mp3", "webm", "ogg"]
    });
    if (res) document.getElementById("merge-audio").value = res;
  });

  document.getElementById("btn-merge-browse-out").addEventListener("click", async () => {
    const res = await invoke("select_save_file", {
      title: "Save Merged Video As",
      defaultName: "merged.mp4",
      filterName: "MP4 Video (*.mp4)",
      filterExts: ["mp4"]
    });
    if (res) document.getElementById("merge-out").value = res;
  });

  // Tools: Audio conversion selectors
  document.getElementById("btn-conv-browse-src").addEventListener("click", async () => {
    const res = await invoke("select_file", {
      title: "Select Audio Source File",
      filterName: "Audio Files",
      filterExts: ["opus", "m4a", "webm", "ogg", "wav"]
    });
    if (res) document.getElementById("conv-src").value = res;
  });

  document.getElementById("btn-conv-browse-out").addEventListener("click", async () => {
    const format = document.getElementById("conv-format").value;
    const name = `converted.${format}`;
    const desc = format.toUpperCase() + " Audio";
    const res = await invoke("select_save_file", {
      title: `Save Converted Audio`,
      defaultName: name,
      filterName: `${desc} (*.${format})`,
      filterExts: [format]
    });
    if (res) document.getElementById("conv-out").value = res;
  });
}

// Initialise Tools execution handlers
function initToolsExecutors() {
  // Run merger
  document.getElementById("btn-run-merge").addEventListener("click", async () => {
    const video = document.getElementById("merge-video").value;
    const audio = document.getElementById("merge-audio").value;
    const out = document.getElementById("merge-out").value;
    
    if (!video || !audio || !out) {
      alert("Please configure video, audio, and output file selections first.");
      return;
    }
    
    const btn = document.getElementById("btn-run-merge");
    btn.disabled = true;
    btn.textContent = "Merging... (Please wait)";
    logToConsole(`Merging files: ${video} + ${audio} → ${out}`);
    
    try {
      await invoke("merge_media", {
        videoPath: video,
        audioPath: audio,
        outPath: out,
        ffmpegPath: appSettings.ffmpeg_path || null
      });
      alert(`Success!\nMerged file saved to:\n${out}`);
      logToConsole(`Merged successfully: ${out}`);
    } catch (err) {
      logToConsole(`Merging failed: ${err}`, "error");
      alert(`Merging failed:\n${err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Merge Files";
    }
  });

  // Run conversion
  document.getElementById("btn-run-conv").addEventListener("click", async () => {
    const src = document.getElementById("conv-src").value;
    const format = document.getElementById("conv-format").value;
    const out = document.getElementById("conv-out").value;
    
    if (!src || !out) {
      alert("Please configure source and destination audio files first.");
      return;
    }
    
    const btn = document.getElementById("btn-run-conv");
    btn.disabled = true;
    btn.textContent = "Converting...";
    logToConsole(`Converting audio file: ${src} → ${out} (${format})`);
    
    try {
      await invoke("convert_audio_format", {
        inPath: src,
        outPath: out,
        format: format,
        ffmpegPath: appSettings.ffmpeg_path || null
      });
      alert(`Success!\nConverted file saved to:\n${out}`);
      logToConsole(`Conversion completed successfully: ${out}`);
    } catch (err) {
      logToConsole(`Conversion failed: ${err}`, "error");
      alert(`Conversion failed:\n${err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Convert Audio";
    }
  });

  // Run Cookies Conversion & Save
  document.getElementById("btn-run-cookies-conv").addEventListener("click", async () => {
    const jsonStr = document.getElementById("cookies-json").value.trim();
    if (!jsonStr) {
      alert("Please paste your JSON cookies array first.");
      return;
    }
    
    try {
      const netscapeTxt = await invoke("convert_cookies", { jsonContent: jsonStr });
      
      // Save selector
      const savePath = await invoke("select_save_file", {
        title: "Save Cookies File",
        defaultName: "cookies.txt",
        filterName: "Text Files (*.txt)",
        filterExts: ["txt"]
      });
      
      if (savePath) {
        await invoke("save_file_content", { path: savePath, content: netscapeTxt });
        alert(`Success!\nNetscape cookies file saved to:\n${savePath}`);
        logToConsole(`Cookies saved successfully to: ${savePath}`);
        
        // Optimistic UI: automatically populate this savePath into the Downloader Cookies Field!
        document.getElementById("cookies-path").value = savePath;
        logToConsole("Loaded parsed cookies.txt into Downloader automatically.");
      }
    } catch (err) {
      logToConsole(`Cookies parsing/saving failed: ${err}`, "error");
      alert(`Failed to convert cookies:\n${err}`);
    }
  });
}

// Initialise Theme Selector Card Events
function initThemeSelector() {
  document.querySelectorAll(".theme-card").forEach(card => {
    card.addEventListener("click", () => {
      const theme = card.querySelector(".theme-name").textContent;
      applyTheme(theme);
      saveSettings();
    });
  });
}

// Initialise Downloader Buttons
function initDownloaderButtons() {
  // Handle cookie source dropdown selection changes
  const cookiesSource = document.getElementById("select-cookies-source");
  const cookiesFileGroup = document.getElementById("cookies-file-group");
  
  cookiesSource.addEventListener("change", () => {
    if (cookiesSource.value === "file") {
      cookiesFileGroup.style.display = "flex";
    } else {
      cookiesFileGroup.style.display = "none";
    }
    logToConsole(`Cookies authentication source set to: ${cookiesSource.value}`);
  });

  document.getElementById("btn-fetch").addEventListener("click", fetchVideoInfo);
  document.getElementById("btn-clear").addEventListener("click", () => {
    document.getElementById("video-url").value = "";
    document.getElementById("downloader-dashboard").style.display = "none";
    document.getElementById("progress-panel").style.display = "none";
    logToConsole("Downloader interface cleared.");
  });

  // Action buttons
  document.getElementById("btn-dl-progressive").addEventListener("click", () => {
    const val = document.getElementById("select-progressive").value;
    if (val) {
      if (videoOnlyIds.has(val)) {
        startDownload(`${val}+bestaudio`);
      } else {
        startDownload(val);
      }
    }
  });

  document.getElementById("btn-dl-video").addEventListener("click", () => {
    const val = document.getElementById("select-video-only").value;
    if (val) startDownload(val);
  });

  document.getElementById("btn-dl-audio").addEventListener("click", () => {
    const val = document.getElementById("select-audio-only").value;
    if (val) {
      // Ask user optimistically if they want to extract to MP3
      const convert = confirm("Download audio and convert to MP3 (recommended for compatibility)?");
      startDownload(val, convert);
    }
  });

  document.getElementById("btn-cancel-dl").addEventListener("click", cancelActiveDownload);
}

// Safely evaluate Tauri window control helper
async function handleWindowAction(action) {
  if (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow) {
    const appWindow = window.__TAURI__.window.getCurrentWindow();
    if (action === "minimize") {
      await appWindow.minimize();
    } else if (action === "maximize") {
      await appWindow.toggleMaximize();
    } else if (action === "close") {
      await appWindow.close();
    }
  } else {
    console.warn(`Tauri window control not available. Mocking window action: ${action}`);
  }
}

// Initialise custom window titlebar buttons
function initTitlebarControls() {
  document.getElementById("titlebar-minimize").addEventListener("click", () => handleWindowAction("minimize"));
  document.getElementById("titlebar-maximize").addEventListener("click", () => handleWindowAction("maximize"));
  document.getElementById("titlebar-close").addEventListener("click", () => handleWindowAction("close"));
}

// Disable default browser behaviors (shortcuts and right-click) to give a native feel
function disableBrowserDefaults() {
  // Prevent context menu (right-click inspector)
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  }, { capture: true });

  // Prevent browser default shortcuts
  window.addEventListener("keydown", (e) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const ctrlKeys = ["r", "p", "s", "f", "g"];
    
    // Ctrl/Cmd + R, P, S, F, G
    if (isCtrlOrCmd && ctrlKeys.includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
    
    // Zoom: Ctrl + +, Ctrl + -, Ctrl + 0
    if (isCtrlOrCmd && (e.key === "=" || e.key === "-" || e.key === "0")) {
      e.preventDefault();
    }
    
    // F5 (Reload), F11 (Fullscreen)
    if (e.key === "F5" || e.key === "F11") {
      e.preventDefault();
    }
  }, { capture: true });
}

// Main Initialisation on Document Load
window.addEventListener("DOMContentLoaded", async () => {
  logToConsole("Initializing MediaPull UI...");
  
  // Disable default browser behaviors
  disableBrowserDefaults();
  
  // Initialise window controls
  initTitlebarControls();
  
  // Set default save folder to user's home downloads dir or generic Downloads
  document.getElementById("save-folder").value = "C:\\Users\\sharm\\Downloads"; // Fallback static representation, select_folder works dynamically
  
  // Run init steps
  initNavigation();
  initConsoleToggle();
  initFilePickers();
  initThemeSelector();
  initDownloaderButtons();
  initToolsExecutors();
  
  // Load settings (updates theme and checks binaries in background)
  await loadSettings();
  
  // Connect Event listeners
  await setupDownloadListeners();

  // Listen to FFmpeg automatic downloader status changes
  await listen("ffmpeg-download-status", (event) => {
    document.getElementById("ffmpeg-dl-status").textContent = event.payload;
    logToConsole(`FFmpeg Installer: ${event.payload}`);
  });
  
  // Handle About Page Link Clicks (opening in default system browser)
  document.querySelectorAll(".about-link").forEach(link => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const url = link.getAttribute("href");
      if (window.__TAURI__ && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
        await window.__TAURI__.opener.openUrl(url);
      } else {
        window.open(url, "_blank");
      }
    });
  });
  
  // Dismiss splash screen loader with a small timeout for premium feels
  setTimeout(() => {
    const splash = document.getElementById("splash-screen");
    if (splash) {
      splash.classList.add("fade-out");
    }
  }, 2200);
  
  logToConsole("MediaPull successfully initialized. Ready to download.");
});
