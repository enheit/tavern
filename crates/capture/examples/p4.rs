//! S5.1 DoD: P4 re-run through the REAL capture impl (full convert+scale pipeline, unlike
//! the count-only S1.6 spike). macOS runtime; release build required (S1.6 finding).
//!
//!   cargo run -p tavern-capture --example p4 --release
//!
//! Gates (P4): achieved fps ≥ 0.8×30 (=24) for 10 s at 720p30 and 1080p30 through
//! `NativeBackend::open_screen`. 120 fps: record only. Writes docs/spike-results/s5.1-p4.json.

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("p4: macOS-only runtime (Win/Linux capture runtime deferred per §1)");
}

#[cfg(target_os = "macos")]
fn main() {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tavern_capture::{CaptureBackend, CaptureConfig, NativeBackend};

    let secs = 10u64;
    let mut results = Vec::new();
    let mut all_pass = true;

    for (label, height, fps, gated) in [
        ("720p30", 720u32, 30u32, true),
        ("1080p30", 1080, 30, true),
        ("native120", 0, 120, false),
    ] {
        let frames = Arc::new(AtomicU64::new(0));
        let dims = Arc::new(Mutex::new((0u32, 0u32)));
        let sink = {
            let frames = frames.clone();
            let dims = dims.clone();
            Box::new(move |f: tavern_capture::Frame| {
                use libwebrtc::video_frame::VideoBuffer;
                *dims.lock().unwrap() = (f.buffer.width(), f.buffer.height());
                frames.fetch_add(1, Ordering::Relaxed);
            })
        };

        let mut session = NativeBackend
            .open_screen(
                "screen:primary",
                CaptureConfig {
                    width: 0,
                    height,
                    fps,
                },
                sink,
            )
            .expect("open_screen (grant Screen Recording TCC to this binary)");

        let t0 = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_secs(secs));
        let elapsed = t0.elapsed().as_secs_f64();
        let n = frames.load(Ordering::Relaxed);
        let achieved = n as f64 / elapsed;
        let source = session.source_size();
        session.stop();

        let pass = !gated || achieved >= 24.0;
        all_pass &= pass;
        let (ew, eh) = *dims.lock().unwrap();
        println!(
            "P4 {label}: frames={n} achieved={achieved:.2} fps emitted={ew}x{eh} source={source:?} {}",
            if gated {
                if pass { "PASS (>=24)" } else { "FAIL (<24)" }
            } else {
                "(record only)"
            }
        );
        results.push(serde_json::json!({
            "target": label, "heightSel": height, "fps": fps, "durationS": secs,
            "frames": n, "achievedFps": (achieved * 100.0).round() / 100.0,
            "emittedW": ew, "emittedH": eh,
            "sourceW": source.map(|s| s.0), "sourceH": source.map(|s| s.1),
            "gated": gated, "pass": pass
        }));
    }

    let out = format!(
        "{}/../../docs/spike-results/s5.1-p4.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let report = serde_json::json!({
        "step": "S5.1", "gate": "P4 re-run through crates/capture real impl",
        "pipeline": "DesktopCapturer -> BGRA->I420 (libyuv) -> scale -> sink, per frame",
        "results": results, "pass": all_pass
    });
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("wrote {out}");
    if !all_pass {
        std::process::exit(1);
    }
}
