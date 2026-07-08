//! Tavern screen/webcam capture: sources → pump thread → I420 frames into a sink.
//!
//! Screen/window capture rides libwebrtc's `DesktopCapturer` (the S1.6-spike-proven path:
//! ScreenCaptureKit on macOS, DXGI/GDI on Windows, X11/PipeWire on Linux); webcams ride
//! `nokhwa`. Frames are emitted as `VideoFrame<I420Buffer>` at the §1-table target size,
//! ready for `NativeVideoSource::capture_frame` (S5.2).

pub mod config;
pub mod frame;

mod fake;
mod screen;
mod webcam;

pub use fake::FakeBackend;
pub use frame::Frame;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Screen,
    Window,
}

/// One shareable screen or window (§1 `screen_sources()` shape).
#[derive(Clone, Debug)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
}

#[derive(Clone, Debug)]
pub struct WebcamInfo {
    pub id: String,
    pub name: String,
}

/// §1 command shape: `width`/`height` 0 = native (screen only); `fps` 0 defaults to 30.
#[derive(Clone, Copy, Debug)]
pub struct CaptureConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl CaptureConfig {
    pub(crate) fn fps_or_default(&self) -> u32 {
        if self.fps == 0 {
            30
        } else {
            self.fps
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    /// OS-level permission missing (macOS Screen Recording / camera TCC).
    Permission(String),
    /// Linux: xdg-desktop-portal / PipeWire screen capture unavailable (§1 typed error).
    PortalUnavailable(String),
    SourceNotFound(String),
    /// Device/stream failure (open, format negotiation, capturer creation).
    Device(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Permission(m) => write!(f, "permission denied: {m}"),
            CaptureError::PortalUnavailable(m) => write!(f, "portal unavailable: {m}"),
            CaptureError::SourceNotFound(m) => write!(f, "source not found: {m}"),
            CaptureError::Device(m) => write!(f, "capture device error: {m}"),
        }
    }
}

impl std::error::Error for CaptureError {}

/// Receives converted frames on the capture thread. Must be cheap or frames back up.
pub type FrameSink = Box<dyn FnMut(Frame) + Send + 'static>;

/// A running capture. Dropping it stops the capture and joins the pump thread.
pub trait CaptureSession: Send {
    /// Frames delivered to the sink so far.
    fn frames_delivered(&self) -> u64;
    /// Requested-vs-achieved reporting: delivered / elapsed since open.
    fn achieved_fps(&self) -> f64;
    /// Raw source dims (before scaling), known after the first frame.
    fn source_size(&self) -> Option<(u32, u32)>;
    /// Stop capturing and join the pump thread. Idempotent.
    fn stop(&mut self);
}

/// Capture backend seam — `NativeBackend` in the app, `FakeBackend` in tests (S5.2).
pub trait CaptureBackend: Send + Sync {
    fn list_screen_sources(&self) -> Result<Vec<SourceInfo>, CaptureError>;
    fn list_webcams(&self) -> Result<Vec<WebcamInfo>, CaptureError>;
    fn open_screen(
        &self,
        source_id: &str,
        cfg: CaptureConfig,
        sink: FrameSink,
    ) -> Result<Box<dyn CaptureSession>, CaptureError>;
    fn open_webcam(
        &self,
        device_id: &str,
        cfg: CaptureConfig,
        sink: FrameSink,
    ) -> Result<Box<dyn CaptureSession>, CaptureError>;
}

/// The real per-OS backend.
pub struct NativeBackend;

impl CaptureBackend for NativeBackend {
    fn list_screen_sources(&self) -> Result<Vec<SourceInfo>, CaptureError> {
        screen::list_sources()
    }

    fn list_webcams(&self) -> Result<Vec<WebcamInfo>, CaptureError> {
        webcam::list()
    }

    fn open_screen(
        &self,
        source_id: &str,
        cfg: CaptureConfig,
        sink: FrameSink,
    ) -> Result<Box<dyn CaptureSession>, CaptureError> {
        Ok(Box::new(screen::open(source_id, cfg, sink)?))
    }

    fn open_webcam(
        &self,
        device_id: &str,
        cfg: CaptureConfig,
        sink: FrameSink,
    ) -> Result<Box<dyn CaptureSession>, CaptureError> {
        Ok(Box::new(webcam::open(device_id, cfg, sink)?))
    }
}

/// Boot-time probe: can this OS create a screen capturer at all? (S6.3 Linux portal check.)
pub fn probe_screen_capture() -> Result<(), CaptureError> {
    screen::probe()
}

// ---- shared pump-session plumbing (used by screen, webcam and fake sessions) ----

pub(crate) struct Shared {
    delivered: AtomicU64,
    /// Raw source dims packed (w<<32)|h; 0 = unknown yet.
    src_wh: AtomicU64,
    stop: AtomicBool,
    started: Instant,
}

impl Shared {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            delivered: AtomicU64::new(0),
            src_wh: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            started: Instant::now(),
        })
    }

    pub(crate) fn count_frame(&self) {
        self.delivered.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn set_source_size(&self, w: u32, h: u32) {
        self.src_wh
            .store(((w as u64) << 32) | h as u64, Ordering::Relaxed);
    }

    pub(crate) fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    pub(crate) fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// One capture thread + its shared counters.
pub(crate) struct PumpSession {
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PumpSession {
    pub(crate) fn new(shared: Arc<Shared>, thread: std::thread::JoinHandle<()>) -> Self {
        Self {
            shared,
            thread: Some(thread),
        }
    }
}

impl CaptureSession for PumpSession {
    fn frames_delivered(&self) -> u64 {
        self.shared.delivered.load(Ordering::Relaxed)
    }

    fn achieved_fps(&self) -> f64 {
        let elapsed = self.shared.started.elapsed().as_secs_f64();
        self.frames_delivered() as f64 / elapsed.max(1e-6)
    }

    fn source_size(&self) -> Option<(u32, u32)> {
        match self.shared.src_wh.load(Ordering::Relaxed) {
            0 => None,
            wh => Some(((wh >> 32) as u32, wh as u32)),
        }
    }

    fn stop(&mut self) {
        self.shared.request_stop();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for PumpSession {
    fn drop(&mut self) {
        self.stop();
    }
}
