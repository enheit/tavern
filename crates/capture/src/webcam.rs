//! Webcam capture via nokhwa (§1: AVFoundation / MSMF / V4L2 behind `input-native`).
//!
//! The camera lives on the pump thread; `frame()` blocks at device pace (no poll timer).
//! Frames decode to RGBA then convert to I420 and scale to the §1 webcam plan dims.
//! ponytail: one universal decode path (RGBA) — per-format fast paths (NV12 direct) only if
//! profiling ever demands it; webcams are ≤720p30.

use std::sync::mpsc;
use std::time::Duration;

use libwebrtc::video_frame::VideoBuffer;
use nokhwa::pixel_format::RgbAFormat;
use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
};
use nokhwa::Camera;

use crate::{
    config, frame, CaptureConfig, CaptureError, FrameSink, PumpSession, Shared, WebcamInfo,
};

pub(crate) fn list() -> Result<Vec<WebcamInfo>, CaptureError> {
    let cams = nokhwa::query(ApiBackend::Auto)
        .map_err(|e| CaptureError::Device(format!("webcam query failed: {e}")))?;
    Ok(cams
        .into_iter()
        .map(|c| WebcamInfo {
            id: c.index().to_string(),
            name: c.human_name(),
        })
        .collect())
}

fn parse_index(id: &str) -> CameraIndex {
    match id.parse::<u32>() {
        Ok(n) => CameraIndex::Index(n),
        Err(_) => CameraIndex::String(id.to_string()),
    }
}

pub(crate) fn open(
    device_id: &str,
    cfg: CaptureConfig,
    mut sink: FrameSink,
) -> Result<PumpSession, CaptureError> {
    let index = parse_index(device_id);
    let plan = config::plan_webcam(cfg.width, cfg.height, cfg.fps_or_default()).h;
    let fps = cfg.fps_or_default();
    let shared = Shared::new();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), CaptureError>>();

    let thread = std::thread::spawn({
        let shared = shared.clone();
        move || {
            // Closest-format resolution fails if the FrameFormat doesn't exist on the device,
            // so try the common camera formats in order until one opens.
            let mut cam: Option<Camera> = None;
            let mut last_err = String::from("no camera formats attempted");
            for fmt in [FrameFormat::NV12, FrameFormat::YUYV, FrameFormat::MJPEG] {
                let req = RequestedFormat::new::<RgbAFormat>(RequestedFormatType::Closest(
                    CameraFormat::new_from(cfg.width, cfg.height, fmt, fps),
                ));
                match Camera::new(index.clone(), req) {
                    Ok(c) => {
                        cam = Some(c);
                        break;
                    }
                    Err(e) => last_err = e.to_string(),
                }
            }
            let Some(mut cam) = cam else {
                let _ = ready_tx.send(Err(CaptureError::Device(format!(
                    "webcam open failed: {last_err}"
                ))));
                return;
            };
            if let Err(e) = cam.open_stream() {
                let _ = ready_tx.send(Err(CaptureError::Device(format!(
                    "webcam stream failed: {e}"
                ))));
                return;
            }
            let _ = ready_tx.send(Ok(()));

            while !shared.stopped() {
                let buffer = match cam.frame() {
                    Ok(b) => b,
                    Err(_) => {
                        // Transient device hiccup; brief backoff, give up via stop() only.
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                };
                let Ok(img) = buffer.decode_image::<RgbAFormat>() else {
                    continue;
                };
                let (w, h) = (img.width(), img.height());
                if w < 2 || h < 2 {
                    continue;
                }
                shared.set_source_size(w, h);
                let mut full = frame::rgba_to_i420(img.as_raw(), w * 4, w, h);
                let buf = if (plan.width, plan.height) != (full.width(), full.height()) {
                    full.scale(plan.width as i32, plan.height as i32)
                } else {
                    full
                };
                sink(frame::wrap(buf));
                shared.count_frame();
            }
            let _ = cam.stop_stream();
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(PumpSession::new(shared, thread)),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            shared.request_stop();
            Err(CaptureError::Device(
                "webcam did not start within 10 s".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_index_forms() {
        assert_eq!(parse_index("2"), CameraIndex::Index(2));
        assert_eq!(
            parse_index("FaceTime HD"),
            CameraIndex::String("FaceTime HD".into())
        );
    }
}
