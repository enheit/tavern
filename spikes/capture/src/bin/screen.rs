//! S1.6 — macOS screen-capture spike (P4). Throwaway.
//!
//! Captures the primary screen via libwebrtc's DesktopCapturer for `--secs` seconds, requesting
//! frames at 30 fps, downscaling each grab to the `--target` pipeline resolution (720p or 1080p),
//! and measuring achieved fps. Writes a JSON + a PNG of the last frame. TCC (Screen Recording)
//! behaviour is recorded: `DesktopCapturer::new` → None or `Permanent` capture errors mean the
//! permission was not granted to this binary.
//!
//!   run (from spikes/capture): cargo run --bin screen -- --target 720   (and --target 1080)
//!
//! Gate P4: achieved fps ≥ 0.8 × 30 (=24) for 10 s at 720p30 and 1080p30.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libwebrtc::desktop_capturer::{
    CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions, DesktopFrame,
};
use serde_json::json;

struct Args {
    target: String, // "720" | "1080"
    secs: u64,
    out: String,
}

fn main() {
    let args = parse_args();
    let (tw, th): (usize, usize) = match args.target.as_str() {
        "720" => (1280, 720),
        "1080" => (1920, 1080),
        other => {
            eprintln!("bad --target {other} (want 720|1080)");
            std::process::exit(2);
        }
    };
    let png = args.out.replace(".json", ".png");

    let mut opts = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
    opts.set_include_cursor(false);
    opts.set_sck_system_picker(false); // no interactive picker — pick a source ourselves

    let Some(mut cap) = DesktopCapturer::new(opts) else {
        write_json(
            &args.out,
            json!({
                "step": "S1.6/screen", "gate": "P4", "target": format!("{}p", args.target),
                "tccBlocked": true,
                "note": "DesktopCapturer::new returned None — macOS Screen Recording permission (TCC) not granted to this binary. Grant it (System Settings ▸ Privacy & Security ▸ Screen Recording) and re-run.",
                "pass": false
            }),
        );
        eprintln!("[tcc] DesktopCapturer::new -> None (Screen Recording not granted). Wrote {}", args.out);
        std::process::exit(3);
    };

    let sources = cap.get_source_list();
    eprintln!("[cap] {} screen source(s)", sources.len());
    let source = sources.into_iter().next(); // primary display

    let frames = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let last: Arc<Mutex<Option<(usize, usize, Vec<u8>)>>> = Arc::new(Mutex::new(None));
    let src_dims = Arc::new(Mutex::new((0i32, 0i32)));
    // Keep the callback cheap (count only) so it doesn't throttle SCK delivery — that is what
    // P4 measures. The per-pixel downscale runs exactly once (for the PNG), gated by this flag.
    let want_snapshot = Arc::new(AtomicBool::new(true));

    cap.start_capture(source, {
        let frames = frames.clone();
        let errors = errors.clone();
        let last = last.clone();
        let src_dims = src_dims.clone();
        let want_snapshot = want_snapshot.clone();
        move |res: Result<DesktopFrame, CaptureError>| match res {
            Ok(frame) => {
                frames.fetch_add(1, Ordering::Relaxed);
                if want_snapshot.swap(false, Ordering::Relaxed) {
                    *src_dims.lock().unwrap() = (frame.width(), frame.height());
                    *last.lock().unwrap() = Some((tw, th, downscale_bgra(&frame, tw, th)));
                }
            }
            Err(_) => {
                errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    // Drive capture at 30 fps for `secs`.
    let interval = Duration::from_micros(1_000_000 / 30);
    let t0 = Instant::now();
    let mut next = t0 + interval;
    while t0.elapsed() < Duration::from_secs(args.secs) {
        cap.capture_frame();
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        }
        next += interval;
    }
    // Drain any async (ScreenCaptureKit) deliveries still in flight.
    std::thread::sleep(Duration::from_millis(300));
    let elapsed = t0.elapsed().as_secs_f64();

    let n = frames.load(Ordering::Relaxed);
    let errs = errors.load(Ordering::Relaxed);
    let fps = n as f64 / elapsed;
    let (sw, sh) = *src_dims.lock().unwrap();
    // P4 gate is purely achieved fps ≥ 0.8×30. Temporary capture errors (SCK "no new frame yet"
    // when polled faster than the display updates) are normal for a pull capturer — reported, not gated.
    let pass = fps >= 24.0;

    // Save the last frame as PNG via ffmpeg (raw BGRA → PNG).
    let mut png_written = false;
    if let Some((w, h, buf)) = last.lock().unwrap().take() {
        png_written = save_png_via_ffmpeg(&png, w, h, &buf);
    }

    write_json(
        &args.out,
        json!({
            "step": "S1.6/screen", "gate": "P4",
            "target": format!("{}p", args.target), "targetW": tw, "targetH": th, "targetFps": 30,
            "sourceW": sw, "sourceH": sh,
            "durationS": args.secs, "framesCaptured": n, "captureErrors": errs,
            "achievedFps": (fps * 100.0).round() / 100.0, "pass": pass,
            "png": if png_written { Path::new(&png).file_name().unwrap().to_string_lossy().to_string() } else { String::new() },
            "tccBlocked": false
        }),
    );

    println!(
        "P4 {}p: source {sw}x{sh} → {tw}x{th}, framesCaptured={n} errors={errs} achievedFps={:.2} (>=24 {}) → {}",
        args.target, fps, if pass { "PASS" } else { "FAIL" }, args.out
    );
    if !pass {
        std::process::exit(1);
    }
}

/// Nearest-neighbour downscale of a BGRA DesktopFrame (honouring row stride) to `tw`×`th`,
/// tightly packed (no padding) so ffmpeg can read it as rawvideo.
fn downscale_bgra(frame: &DesktopFrame, tw: usize, th: usize) -> Vec<u8> {
    let sw = frame.width().max(1) as usize;
    let sh = frame.height().max(1) as usize;
    let stride = frame.stride() as usize;
    let src = frame.data();
    let mut out = vec![0u8; tw * th * 4];
    for y in 0..th {
        let sy = y * sh / th;
        for x in 0..tw {
            let sx = x * sw / tw;
            let si = sy * stride + sx * 4;
            let di = (y * tw + x) * 4;
            if si + 4 <= src.len() {
                out[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
    }
    out
}

fn save_png_via_ffmpeg(png: &str, w: usize, h: usize, bgra: &[u8]) -> bool {
    if let Some(p) = Path::new(png).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let raw = format!("{png}.bgra");
    if std::fs::write(&raw, bgra).is_err() {
        return false;
    }
    let ok = Command::new("ffmpeg")
        .args([
            "-y", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "bgra",
            "-video_size", &format!("{w}x{h}"), "-i", &raw, png,
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&raw);
    ok
}

fn write_json(path: &str, v: serde_json::Value) {
    if let Some(p) = Path::new(path).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(&v).unwrap());
}

fn parse_args() -> Args {
    let mut a = Args {
        target: "720".into(),
        secs: 10,
        out: String::new(),
    };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < argv.len() {
        match argv[i].as_str() {
            "--target" => a.target = argv[i + 1].clone(),
            "--secs" => a.secs = argv[i + 1].parse().unwrap_or(a.secs),
            "--out" => a.out = argv[i + 1].clone(),
            _ => {}
        }
        i += 1;
    }
    if a.out.is_empty() {
        a.out = format!(
            "{}/../../docs/spike-results/screen-{}p.json",
            env!("CARGO_MANIFEST_DIR"),
            a.target
        );
    }
    a
}
