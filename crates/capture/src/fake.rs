//! Deterministic in-process backend for tests (S5.1 lifecycle DoD; S5.2 engine tests).
//! Emits synthetic I420 frames at the configured fps through the same `PumpSession`
//! plumbing as the real backends. The fake "screen" source is 1600×1000.

use std::time::{Duration, Instant};

use libwebrtc::video_frame::I420Buffer;

use crate::{
    config, frame, CaptureBackend, CaptureConfig, CaptureError, CaptureSession, FrameSink,
    PumpSession, Shared, SourceInfo, SourceKind, WebcamInfo,
};

pub const FAKE_SCREEN_W: u32 = 1600;
pub const FAKE_SCREEN_H: u32 = 1000;

pub struct FakeBackend;

impl CaptureBackend for FakeBackend {
    fn list_screen_sources(&self) -> Result<Vec<SourceInfo>, CaptureError> {
        Ok(vec![
            SourceInfo {
                id: "screen:primary".into(),
                name: "Fake Screen".into(),
                kind: SourceKind::Screen,
            },
            SourceInfo {
                id: "window:42".into(),
                name: "Fake Window".into(),
                kind: SourceKind::Window,
            },
        ])
    }

    fn list_webcams(&self) -> Result<Vec<WebcamInfo>, CaptureError> {
        Ok(vec![WebcamInfo {
            id: "0".into(),
            name: "Fake Cam".into(),
        }])
    }

    fn open_screen(
        &self,
        source_id: &str,
        cfg: CaptureConfig,
        sink: FrameSink,
    ) -> Result<Box<dyn CaptureSession>, CaptureError> {
        if !source_id.starts_with("screen:") && !source_id.starts_with("window:") {
            return Err(CaptureError::SourceNotFound(source_id.into()));
        }
        let fps = cfg.fps_or_default();
        let target = config::plan_screen(cfg.height, fps, FAKE_SCREEN_W, FAKE_SCREEN_H).h;
        Ok(spawn(
            fps,
            (FAKE_SCREEN_W, FAKE_SCREEN_H),
            (target.width, target.height),
            sink,
        ))
    }

    fn open_webcam(
        &self,
        _device_id: &str,
        cfg: CaptureConfig,
        sink: FrameSink,
    ) -> Result<Box<dyn CaptureSession>, CaptureError> {
        let fps = cfg.fps_or_default();
        let target = config::plan_webcam(cfg.width, cfg.height, fps).h;
        Ok(spawn(
            fps,
            (cfg.width, cfg.height),
            (target.width, target.height),
            sink,
        ))
    }
}

fn spawn(
    fps: u32,
    src: (u32, u32),
    target: (u32, u32),
    mut sink: FrameSink,
) -> Box<dyn CaptureSession> {
    let shared = Shared::new();
    let thread = std::thread::spawn({
        let shared = shared.clone();
        move || {
            shared.set_source_size(src.0, src.1);
            let interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
            let mut next = Instant::now() + interval;
            let mut idx: u64 = 0;
            while !shared.stopped() {
                let mut buf = I420Buffer::new(target.0, target.1);
                let (y, _, _) = buf.data_mut();
                y.fill((idx.wrapping_mul(7) & 0xff) as u8);
                sink(frame::wrap(buf));
                shared.count_frame();
                idx += 1;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                }
                next += interval;
            }
        }
    });
    Box::new(PumpSession::new(shared, thread))
}

#[cfg(test)]
mod tests {
    use super::*;
    use libwebrtc::video_frame::VideoBuffer;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    type Dims = Arc<Mutex<(u32, u32)>>;

    fn counting_sink() -> (Arc<AtomicU64>, Dims, FrameSink) {
        let n = Arc::new(AtomicU64::new(0));
        let dims = Arc::new(Mutex::new((0, 0)));
        let sink = {
            let n = n.clone();
            let dims = dims.clone();
            Box::new(move |f: frame::Frame| {
                *dims.lock().unwrap() = (f.buffer.width(), f.buffer.height());
                n.fetch_add(1, Ordering::Relaxed);
            })
        };
        (n, dims, sink)
    }

    fn wait_frames(n: &AtomicU64, at_least: u64) {
        let t0 = Instant::now();
        while n.load(Ordering::Relaxed) < at_least {
            assert!(
                t0.elapsed() < Duration::from_secs(5),
                "timed out waiting for frames"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// DoD: fake-capturer lifecycle — open → frames flow at plan dims → stop is clean,
    /// joins the thread, halts frames, and is idempotent.
    #[test]
    fn screen_lifecycle() {
        let (n, dims, sink) = counting_sink();
        let mut s = FakeBackend
            .open_screen(
                "screen:primary",
                CaptureConfig {
                    width: 0,
                    height: 720,
                    fps: 30,
                },
                sink,
            )
            .unwrap();

        wait_frames(&n, 5);
        // 1600×1000 fake source at a 720 selection → 1152×720 frames (§1 mapping).
        assert_eq!(*dims.lock().unwrap(), (1152, 720));
        assert_eq!(s.source_size(), Some((FAKE_SCREEN_W, FAKE_SCREEN_H)));
        assert!(s.achieved_fps() > 0.0);
        assert!(s.frames_delivered() >= 5);

        s.stop();
        let after = n.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(
            n.load(Ordering::Relaxed),
            after,
            "frames must stop after stop()"
        );
        s.stop(); // idempotent
    }

    #[test]
    fn native_selection_passes_source_dims_through() {
        let (n, dims, sink) = counting_sink();
        let mut s = FakeBackend
            .open_screen(
                "screen:primary",
                CaptureConfig {
                    width: 0,
                    height: 0,
                    fps: 30,
                },
                sink,
            )
            .unwrap();
        wait_frames(&n, 1);
        assert_eq!(*dims.lock().unwrap(), (FAKE_SCREEN_W, FAKE_SCREEN_H));
        s.stop();
    }

    #[test]
    fn webcam_lifecycle_emits_plan_dims() {
        let (n, dims, sink) = counting_sink();
        let mut s = FakeBackend
            .open_webcam(
                "0",
                CaptureConfig {
                    width: 1280,
                    height: 720,
                    fps: 30,
                },
                sink,
            )
            .unwrap();
        wait_frames(&n, 1);
        assert_eq!(*dims.lock().unwrap(), (1280, 720));
        s.stop();
    }

    #[test]
    fn unknown_screen_source_rejected() {
        let (_, _, sink) = counting_sink();
        assert!(matches!(
            FakeBackend.open_screen(
                "bogus",
                CaptureConfig {
                    width: 0,
                    height: 0,
                    fps: 30
                },
                sink
            ),
            Err(CaptureError::SourceNotFound(_))
        ));
    }
}
