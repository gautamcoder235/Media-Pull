use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use regex::Regex;
use tauri::Emitter;
use tauri::Manager;

fn create_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

#[derive(Default)]
pub struct ActiveDownload {
    child: std::sync::Arc<std::sync::Mutex<Option<std::process::Child>>>,
}

impl Clone for ActiveDownload {
    fn clone(&self) -> Self {
        Self {
            child: self.child.clone(),
        }
    }
}

#[derive(serde::Serialize, Clone)]
struct ProgressPayload {
    percent: f32,
    total_size: String,
    speed: String,
    eta: String,
    status_text: String,
}

fn get_binary_path(app_handle: &tauri::AppHandle, dir_path: Option<String>, name: &str) -> Result<String, String> {
    let mut exe_name = name.to_string();
    if cfg!(target_os = "windows") {
        exe_name.push_str(".exe");
    }
    
    // 1. Check custom path in settings first (if user configured one)
    if let Some(path_str) = dir_path {
        if !path_str.trim().is_empty() {
            let path = std::path::Path::new(&path_str);
            if path.is_file() {
                return Ok(path.to_string_lossy().to_string());
            } else if path.is_dir() {
                let full_path = path.join(&exe_name);
                if full_path.exists() {
                    return Ok(full_path.to_string_lossy().to_string());
                }
            }
        }
    }
    
    // 2. Check bundled resources/bin/ directory
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let bundled_path = resource_dir.join("bin").join(&exe_name);
        if bundled_path.exists() {
            return Ok(bundled_path.to_string_lossy().to_string());
        }
    }
    
    // 3. Fallback to system environment PATH
    Ok(exe_name)
}

#[tauri::command]
fn select_folder(default_path: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(ref path) = default_path {
        dialog = dialog.set_directory(path);
    }
    dialog.pick_folder().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn select_file(title: String, filter_name: String, filter_exts: Vec<String>) -> Option<String> {
    let exts: Vec<&str> = filter_exts.iter().map(|s| s.as_str()).collect();
    rfd::FileDialog::new()
        .set_title(&title)
        .add_filter(&filter_name, &exts)
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn select_save_file(title: String, default_name: String, filter_name: String, filter_exts: Vec<String>) -> Option<String> {
    let exts: Vec<&str> = filter_exts.iter().map(|s| s.as_str()).collect();
    rfd::FileDialog::new()
        .set_title(&title)
        .set_file_name(&default_name)
        .add_filter(&filter_name, &exts)
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn verify_binary(app_handle: tauri::AppHandle, path: String, name: String) -> Result<String, String> {
    let bin_path = get_binary_path(&app_handle, Some(path), &name)?;
    let version_arg = if name.to_lowercase().contains("ffmpeg") {
        "-version"
    } else {
        "--version"
    };
    let output = create_command(&bin_path)
        .arg(version_arg)
        .output()
        .map_err(|e| format!("Binary not found or execution failed: {}", e))?;
        
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first_line = stdout.lines().next().unwrap_or("Unknown version");
        Ok(first_line.to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Execution failed: {}", stderr))
    }
}


#[tauri::command]
async fn download_ytdlp(window: tauri::Window, app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {}", e))?;
    
    let ytdlp_path = app_dir.join("yt-dlp.exe");
    
    let window_clone = window.clone();
    
    let res = tokio::task::spawn_blocking(move || {
        let _ = window_clone.emit("ytdlp-download-status", "Downloading latest yt-dlp.exe (approx. 15MB)...");
        
        let _ = std::fs::create_dir_all(&app_dir);
        
        let download_status = create_command("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg(format!(
                "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '{}'",
                ytdlp_path.to_string_lossy()
            ))
            .status();
            
        match download_status {
            Ok(status) if status.success() => {
                let _ = window_clone.emit("ytdlp-download-status", "yt-dlp installation completed!");
                Ok(ytdlp_path.to_string_lossy().to_string())
            },
            _ => Err("Failed to download yt-dlp.exe. Please check your internet connection.".to_string()),
        }
    }).await.map_err(|e| format!("Task execution failed: {}", e))?;
    
    res
}

#[tauri::command]
fn load_app_settings(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let settings_file = config_dir.join("app_settings.json");
    
    if settings_file.exists() {
        let content = std::fs::read_to_string(settings_file)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        let val: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?;
        Ok(val)
    } else {
        Ok(serde_json::json!({
            "ffmpeg_path": "C:\\ffmpeg\\bin",
            "ytdlp_path": "",
            "current_theme": "Tokyo Night"
        }))
    }
}

#[tauri::command]
fn save_app_settings(app_handle: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config folder: {}", e))?;
        
    let settings_file = config_dir.join("app_settings.json");
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to format settings: {}", e))?;
        
    std::fs::write(settings_file, content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;
        
    Ok(())
}

#[tauri::command]
fn convert_cookies(json_content: String) -> Result<String, String> {
    let cookies: Vec<serde_json::Value> = serde_json::from_str(&json_content)
        .map_err(|e| format!("Invalid JSON format: {}", e))?;
        
    let mut netscape = String::new();
    netscape.push_str("# Netscape HTTP Cookie File\n");
    netscape.push_str("# Converted from JSON\n");
    
    for c in cookies {
        let domain = c.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        let host_only = c.get("hostOnly").and_then(|v| v.as_bool()).unwrap_or(false);
        let flag = if host_only { "FALSE" } else { "TRUE" };
        let path = c.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let secure = c.get("secure").and_then(|v| v.as_bool()).unwrap_or(false);
        let secure_str = if secure { "TRUE" } else { "FALSE" };
        
        let expiry = c.get("expirationDate")
            .and_then(|v| v.as_f64().map(|f| f as i64))
            .unwrap_or(2147483647);
            
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
        
        let line = format!("{}\t{}\t{}\t{}\t{}\t{}\t{}\n", domain, flag, path, secure_str, expiry, name, value);
        netscape.push_str(&line);
    }
    
    Ok(netscape)
}

#[tauri::command]
fn fetch_video_metadata(
    app_handle: tauri::AppHandle,
    url: String,
    cookies_path: Option<String>,
    ytdlp_path: Option<String>,
) -> Result<String, String> {
    let ytdlp_bin = get_binary_path(&app_handle, ytdlp_path, "yt-dlp")?;
    
    let mut cmd = create_command(&ytdlp_bin);
    cmd.env("PYTHONWARNINGS", "ignore");
    cmd.args(&["--dump-json", "--skip-download", "--no-warnings", &url]);
    
    if let Some(cookies) = cookies_path {
        if !cookies.trim().is_empty() {
            if cookies.starts_with("browser:") {
                let browser = cookies.replace("browser:", "");
                cmd.args(&["--cookies-from-browser", &browser]);
            } else {
                cmd.args(&["--cookies", &cookies]);
            }
        }
    }
    
    let output = cmd.output()
        .map_err(|e| format!("Failed to run yt-dlp: {}. Make sure it is installed and path is configured.", e))?;
        
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("yt-dlp error: {}", stderr))
    }
}

#[tauri::command]
fn download_media(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, ActiveDownload>,
    url: String,
    out_folder: String,
    format_id: String,
    cookies_path: Option<String>,
    ytdlp_path: Option<String>,
    ffmpeg_path: Option<String>,
    convert_to_mp3: bool,
) -> Result<(), String> {
    let ytdlp_bin = get_binary_path(&app_handle, ytdlp_path, "yt-dlp")?;
    
    let mut args = vec![
        "--newline".to_string(),
        "--no-warnings".to_string(),
        "-f".to_string(),
        format_id,
        "-P".to_string(),
        out_folder,
        url,
    ];
    
    if let Some(cookies) = cookies_path {
        if !cookies.trim().is_empty() {
            if cookies.starts_with("browser:") {
                let browser = cookies.replace("browser:", "");
                args.push("--cookies-from-browser".to_string());
                args.push(browser);
            } else {
                args.push("--cookies".to_string());
                args.push(cookies);
            }
        }
    }
    
    let resolved_ffmpeg = if let Some(ref ffmpeg) = ffmpeg_path {
        if !ffmpeg.trim().is_empty() {
            Some(ffmpeg.clone())
        } else {
            None
        }
    } else {
        None
    };

    let ffmpeg_location = if let Some(ffmpeg) = resolved_ffmpeg {
        if std::path::Path::new(&ffmpeg).is_file() {
            Some(std::path::Path::new(&ffmpeg).parent().unwrap().to_path_buf())
        } else {
            Some(std::path::Path::new(&ffmpeg).to_path_buf())
        }
    } else {
        // Fallback to check bundled bin folder for ffmpeg
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled_ffmpeg = resource_dir.join("bin").join("ffmpeg.exe");
            if bundled_ffmpeg.exists() {
                Some(resource_dir.join("bin"))
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(location) = ffmpeg_location {
        args.push("--ffmpeg-location".to_string());
        args.push(location.to_string_lossy().to_string());
    }
    
    if convert_to_mp3 {
        args.push("-x".to_string());
        args.push("--audio-format".to_string());
        args.push("mp3".to_string());
        args.push("--audio-quality".to_string());
        args.push("192K".to_string());
    }

    let mut cmd = create_command(&ytdlp_bin);
    cmd.env("PYTHONWARNINGS", "ignore");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        
    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start download process: {}", e))?;
        
    {
        let mut active_child = state.child.lock().unwrap();
        *active_child = Some(child);
    }
    
    let active_child_state = state.inner().clone();
    let thread_window = window.clone();
    
    std::thread::spawn(move || {
        let mut stdout_opt = None;
        {
            let mut active = active_child_state.child.lock().unwrap();
            if let Some(ref mut child) = *active {
                stdout_opt = child.stdout.take();
            }
        }
        
        if let Some(stdout) = stdout_opt {
            let reader = BufReader::new(stdout);
            
            // Progress regex matcher
            let re = Regex::new(
                r"(\d+(?:\.\d+)?)\%\s+of\s+(\S+)(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?"
            ).unwrap();
            
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    if let Some(caps) = re.captures(&line) {
                        let percent: f32 = caps.get(1).map_or(0.0, |m| m.as_str().parse().unwrap_or(0.0));
                        let total_size = caps.get(2).map_or("", |m| m.as_str()).to_string();
                        let speed = caps.get(3).map_or("", |m| m.as_str()).to_string();
                        let eta = caps.get(4).map_or("", |m| m.as_str()).to_string();
                        
                        let payload = ProgressPayload {
                            percent,
                            total_size,
                            speed,
                            eta,
                            status_text: format!("Downloading: {}%", percent),
                        };
                        let _ = thread_window.emit("download-progress", payload);
                    } else if line.contains("[download] Destination") {
                        let payload = ProgressPayload {
                            percent: 0.0,
                            total_size: "".to_string(),
                            speed: "".to_string(),
                            eta: "".to_string(),
                            status_text: "Starting download...".to_string(),
                        };
                        let _ = thread_window.emit("download-progress", payload);
                    } else if line.contains("[Merger]") || line.contains("[ExtractAudio]") {
                        let payload = ProgressPayload {
                            percent: 100.0,
                            total_size: "".to_string(),
                            speed: "".to_string(),
                            eta: "".to_string(),
                            status_text: "Processing media (merging/converting)...".to_string(),
                        };
                        let _ = thread_window.emit("download-progress", payload);
                    }
                }
            }
            
            // Re-acquire lock to take the child process and wait on it
            let child_opt = {
                let mut active = active_child_state.child.lock().unwrap();
                active.take()
            };
            
            let status_payload = if let Some(mut child) = child_opt {
                let status = child.wait();
                match status {
                    Ok(s) if s.success() => ProgressPayload {
                        percent: 100.0,
                        total_size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status_text: "Download completed successfully!".to_string(),
                    },
                    Ok(s) => ProgressPayload {
                        percent: 0.0,
                        total_size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status_text: format!("Download failed or stopped. Exit code: {:?}", s.code()),
                    },
                    Err(e) => ProgressPayload {
                        percent: 0.0,
                        total_size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status_text: format!("Error waiting for process: {}", e),
                    },
                }
            } else {
                ProgressPayload {
                    percent: 0.0,
                    total_size: "".to_string(),
                    speed: "".to_string(),
                    eta: "".to_string(),
                    status_text: "Download cancelled by user.".to_string(),
                }
            };
            
            let _ = thread_window.emit("download-finished", status_payload);
        }
    });
    
    Ok(())
}

#[tauri::command]
fn cancel_download(state: tauri::State<'_, ActiveDownload>) -> Result<String, String> {
    let mut active = state.child.lock().unwrap();
    if let Some(mut child) = active.take() {
        let _ = child.kill();
        Ok("Download cancelled".to_string())
    } else {
        Err("No active download to cancel".to_string())
    }
}

#[tauri::command]
fn merge_media(
    app_handle: tauri::AppHandle,
    video_path: String,
    audio_path: String,
    out_path: String,
    ffmpeg_path: Option<String>,
) -> Result<String, String> {
    let ffmpeg_bin = get_binary_path(&app_handle, ffmpeg_path, "ffmpeg")?;
    
    let output = create_command(&ffmpeg_bin)
        .args(&["-y", "-i", &video_path, "-i", &audio_path, "-c:v", "copy", "-c:a", "copy", &out_path])
        .output()
        .map_err(|e| format!("Failed to execute ffmpeg: {}", e))?;
        
    if output.status.success() {
        Ok(out_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ffmpeg failed: {}", stderr))
    }
}

#[tauri::command]
fn convert_media(
    app_handle: tauri::AppHandle,
    in_path: String,
    out_path: String,
    format: String,
    ffmpeg_path: Option<String>,
) -> Result<String, String> {
    let ffmpeg_bin = get_binary_path(&app_handle, ffmpeg_path, "ffmpeg")?;
    
    let format_lower = format.to_lowercase();
    let mut args = vec!["-y".to_string(), "-i".to_string(), in_path];
    
    match format_lower.as_str() {
        // Audio Formats
        "mp3" => {
            args.extend(vec!["-vn".to_string(), "-c:a".to_string(), "libmp3lame".to_string(), "-b:a".to_string(), "192k".to_string()]);
        },
        "m4a" => {
            args.extend(vec!["-vn".to_string(), "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "192k".to_string()]);
        },
        "wav" => {
            args.extend(vec!["-vn".to_string(), "-c:a".to_string(), "pcm_s16le".to_string()]);
        },
        "flac" => {
            args.extend(vec!["-vn".to_string(), "-c:a".to_string(), "flac".to_string()]);
        },
        "ogg" => {
            args.extend(vec!["-vn".to_string(), "-c:a".to_string(), "libopus".to_string(), "-b:a".to_string(), "128k".to_string()]);
        },
        // Video Formats
        "mp4" => {
            args.extend(vec!["-c:v".to_string(), "libx264".to_string(), "-pix_fmt".to_string(), "yuv420p".to_string(), "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "192k".to_string()]);
        },
        "mkv" => {
            args.extend(vec!["-c:v".to_string(), "libx264".to_string(), "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "192k".to_string()]);
        },
        "webm" => {
            args.extend(vec!["-c:v".to_string(), "libvpx-vp9".to_string(), "-crf".to_string(), "30".to_string(), "-b:v".to_string(), "0".to_string(), "-c:a".to_string(), "libopus".to_string()]);
        },
        _ => {
            args.extend(vec!["-c".to_string(), "copy".to_string()]);
        }
    }
    
    args.push(out_path.clone());
    
    let output = create_command(&ffmpeg_bin)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute ffmpeg: {}", e))?;
        
    if output.status.success() {
        Ok(out_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ffmpeg conversion failed: {}", stderr))
    }
}

#[tauri::command]
fn save_file_content(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("Failed to save file: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ActiveDownload::default())
        .invoke_handler(tauri::generate_handler![
            select_folder,
            select_file,
            select_save_file,
            verify_binary,
            load_app_settings,
            save_app_settings,
            convert_cookies,
            save_file_content,
            fetch_video_metadata,
            download_media,
            cancel_download,
            merge_media,
            convert_media,
            download_ytdlp
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
