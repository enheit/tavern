//! Screen/window capture via libwebrtc's `DesktopCapturer` (pull model, S1.6-proven).
//!
//! The capturer is not `Send`, so it lives entirely on the pump thread: create → select
//! source → `start_capture` → poll `capture_frame()` at the target fps until stopped.
//! macOS reality (probed, S5.1): with the SCK system picker disabled, screens do NOT
//! enumerate — only `start_capture(None)` (primary display) works — while windows DO
//! enumerate and capture. Source ids are `screen:primary`, `screen:<id>`, `window:<id>`.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use libwebrtc::desktop_capturer::{
    CaptureError as DcError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use libwebrtc::video_frame::VideoBuffer;

use crate::{
    config, frame, CaptureConfig, CaptureError, FrameSink, PumpSession, Shared, SourceInfo,
    SourceKind,
};

/// `screen:primary` — capture the default display via `start_capture(None)` (macOS SCK).
const PRIMARY: &str = "primary";

fn make_capturer(kind: SourceKind) -> Option<DesktopCapturer> {
    let mut opts = DesktopCapturerOptions::new(match kind {
        SourceKind::Screen => DesktopCaptureSourceType::Screen,
        SourceKind::Window => DesktopCaptureSourceType::Window,
    });
    // Viewers expect to see the presenter's pointer.
    opts.set_include_cursor(true);
    #[cfg(target_os = "macos")]
    opts.set_sck_system_picker(false); // Tavern has its own picker (S5.3)
    DesktopCapturer::new(opts)
}

/// Why capturer creation failed, per OS (§1 Linux typed portal error; macOS TCC).
fn creation_error() -> CaptureError {
    #[cfg(target_os = "macos")]
    return CaptureError::Permission(
        "macOS Screen Recording permission not granted (System Settings ▸ Privacy & Security ▸ Screen Recording)".into(),
    );
    #[cfg(target_os = "linux")]
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        return CaptureError::PortalUnavailable(
            "screen capture on Wayland requires xdg-desktop-portal + PipeWire".into(),
        );
    }
    #[allow(unreachable_code)]
    CaptureError::Device("failed to create desktop capturer".into())
}

pub(crate) fn probe() -> Result<(), CaptureError> {
    make_capturer(SourceKind::Screen)
        .map(drop)
        .ok_or_else(creation_error)
}

pub(crate) fn list_sources() -> Result<Vec<SourceInfo>, CaptureError> {
    let mut out = Vec::new();

    let screens = make_capturer(SourceKind::Screen).ok_or_else(creation_error)?;
    let screens = screens.get_source_list();
    if screens.is_empty() {
        // macOS SCK: screens don't enumerate with the picker disabled; only the primary
        // display is reachable (start_capture(None)).
        // ponytail: multi-display macOS needs an upstream CaptureSource constructor — v1 ceiling.
        out.push(SourceInfo {
            id: format!("screen:{PRIMARY}"),
            name: "Primary Display".into(),
            kind: SourceKind::Screen,
        });
    } else {
        for (i, s) in screens.iter().enumerate() {
            let title = s.title();
            out.push(SourceInfo {
                id: format!("screen:{}", s.id()),
                name: if title.is_empty() {
                    format!("Screen {}", i + 1)
                } else {
                    title
                },
                kind: SourceKind::Screen,
            });
        }
    }

    // Windows are best-effort: a failing window capturer must not kill screen sharing.
    if let Some(cap) = make_capturer(SourceKind::Window) {
        for s in cap.get_source_list() {
            let title = s.title();
            if title.is_empty() {
                continue;
            }
            out.push(SourceInfo {
                id: format!("window:{}", s.id()),
                name: title,
                kind: SourceKind::Window,
            });
        }
    }

    Ok(out)
}

/// Parsed source id: kind + raw capturer source id (None = primary via start_capture(None)).
fn parse_id(id: &str) -> Result<(SourceKind, Option<u64>), CaptureError> {
    let bad = || CaptureError::SourceNotFound(format!("bad source id: {id}"));
    let (kind, raw) = id.split_once(':').ok_or_else(bad)?;
    match (kind, raw) {
        ("screen", PRIMARY) => Ok((SourceKind::Screen, None)),
        ("screen", n) => Ok((SourceKind::Screen, Some(n.parse().map_err(|_| bad())?))),
        ("window", n) => Ok((SourceKind::Window, Some(n.parse().map_err(|_| bad())?))),
        _ => Err(bad()),
    }
}

pub(crate) fn open(
    source_id: &str,
    cfg: CaptureConfig,
    mut sink: FrameSink,
) -> Result<PumpSession, CaptureError> {
    let (kind, raw_id) = parse_id(source_id)?;
    let shared = Shared::new();
    let fps = cfg.fps_or_default();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), CaptureError>>();

    let thread = std::thread::spawn({
        let shared = shared.clone();
        move || {
            let Some(mut cap) = make_capturer(kind) else {
                let _ = ready_tx.send(Err(creation_error()));
                return;
            };
            let source = match raw_id {
                None => None,
                Some(id) => match cap.get_source_list().into_iter().find(|s| s.id() == id) {
                    Some(s) => Some(s),
                    None => {
                        let _ = ready_tx.send(Err(CaptureError::SourceNotFound(format!(
                            "source id {id} no longer available"
                        ))));
                        return;
                    }
                },
            };

            cap.start_capture(source, {
                let shared = shared.clone();
                move |result| match result {
                    Ok(df) => {
                        let (sw, sh) = (df.width() as u32, df.height() as u32);
                        if sw < 2 || sh < 2 {
                            return;
                        }
                        shared.set_source_size(sw, sh);
                        let target = config::plan_screen(cfg.height, fps, sw, sh).h;
                        let mut full = frame::bgra_to_i420(df.data(), df.stride(), sw, sh);
                        let buf = if (target.width, target.height) != (full.width(), full.height())
                        {
                            full.scale(target.width as i32, target.height as i32)
                        } else {
                            full
                        };
                        sink(frame::wrap(buf));
                        shared.count_frame();
                    }
                    // Temporary = "no new frame yet" when polling faster than the display
                    // updates — normal for a pull capturer (S1.6).
                    Err(DcError::Temporary) => {}
                    // Permanent = source gone (window closed, display detached): end the pump.
                    Err(DcError::Permanent) => shared.request_stop(),
                }
            });
            let _ = ready_tx.send(Ok(()));

            let interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
            let mut next = Instant::now() + interval;
            while !shared.stopped() {
                cap.capture_frame();
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                }
                next += interval;
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(PumpSession::new(shared, thread)),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            shared.request_stop();
            Err(CaptureError::Device(
                "capturer did not start within 5 s".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ids() {
        assert_eq!(
            parse_id("screen:primary").unwrap(),
            (SourceKind::Screen, None)
        );
        assert_eq!(parse_id("screen:3").unwrap(), (SourceKind::Screen, Some(3)));
        assert_eq!(
            parse_id("window:42").unwrap(),
            (SourceKind::Window, Some(42))
        );
        assert!(parse_id("bogus").is_err());
        assert!(parse_id("window:abc").is_err());
        assert!(parse_id("webcam:0").is_err());
    }
}
