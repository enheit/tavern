// Prevent an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer aborts on some GPU drivers (NVIDIA, some
    // mesa setups) with "Could not create default EGL display: EGL_BAD_PARAMETER".
    // Fall back to the non-DMABUF path unless the user overrides (set =0).
    // ponytail: blanket opt-out; revisit if Linux video perf gates ever run.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tavern_desktop_lib::run();
}
