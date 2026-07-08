//! Video publish (screen/webcam) decision logic — pure and unit-tested (S5.2).
//!
//! [`encodings_for`] turns a §1 [`EncodingPlan`] into the libwebrtc `send_encodings`
//! (the S1.3-proven simulcast shape: rid "h" scale 1.0 + rid "l", asciibetical order).
//! [`SharesSm`] guards one active share per kind; [`error_event_code`] maps signaling
//! failures to the typed engine error events the UI listens for (share-cap 409 → 409
//! `share_limit`).

use libwebrtc::rtp_parameters::RtpEncodingParameters;
use tavern_capture::config::EncodingPlan;

use crate::signaling::SignalError;
use crate::state::EngineError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoKind {
    Screen,
    Webcam,
}

impl VideoKind {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoKind::Screen => "screen",
            VideoKind::Webcam => "webcam",
        }
    }
}

/// §1 plan → libwebrtc send_encodings. Simulcast rows emit [h, l] (h first — asciibetical rid
/// priority, S1.3); single rows emit one rid-less encoding carrying the row's bitrate cap.
pub fn encodings_for(plan: &EncodingPlan) -> Vec<RtpEncodingParameters> {
    let h = RtpEncodingParameters {
        rid: if plan.simulcast() {
            "h".into()
        } else {
            String::new()
        },
        scale_resolution_down_by: Some(1.0),
        max_bitrate: Some(plan.h.max_kbps as u64 * 1000),
        max_framerate: Some(plan.h.fps as f64),
        ..Default::default()
    };
    match plan.l {
        None => vec![h],
        Some(l) => vec![
            h,
            RtpEncodingParameters {
                rid: "l".into(),
                scale_resolution_down_by: Some(plan.h.height as f64 / l.height as f64),
                max_bitrate: Some(l.max_kbps as u64 * 1000),
                max_framerate: Some(l.fps as f64),
                ..Default::default()
            },
        ],
    }
}

/// Typed engine error-event code for a failed video publish, if the failure maps to one the
/// UI reacts to (§1 error codes). The share cap is the S5.2 DoD case.
pub fn error_event_code(e: &EngineError) -> Option<&'static str> {
    match e {
        EngineError::Signaling(SignalError::Http {
            status: 409,
            code: Some(c),
        }) if c == "share_limit" => Some("share_limit"),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum ShareState {
    #[default]
    Idle,
    /// begin() taken; publish I/O in flight (blocks concurrent starts of the same kind).
    Starting,
    Active(String),
}

/// One active share per kind (screen_share_start/stop + webcam_start/stop are singular, §1).
#[derive(Default)]
pub struct SharesSm {
    screen: ShareState,
    webcam: ShareState,
}

impl SharesSm {
    fn slot(&mut self, kind: VideoKind) -> &mut ShareState {
        match kind {
            VideoKind::Screen => &mut self.screen,
            VideoKind::Webcam => &mut self.webcam,
        }
    }

    /// Idle → Starting; any live state rejects (already sharing).
    pub fn begin(&mut self, kind: VideoKind) -> Result<(), EngineError> {
        let slot = self.slot(kind);
        match slot {
            ShareState::Idle => {
                *slot = ShareState::Starting;
                Ok(())
            }
            _ => Err(EngineError::AlreadySharing),
        }
    }

    /// Starting → Active(trackName) after a successful publish.
    pub fn mark_active(&mut self, kind: VideoKind, track_name: &str) {
        *self.slot(kind) = ShareState::Active(track_name.to_string());
    }

    /// Roll a failed Starting back to Idle.
    pub fn abort(&mut self, kind: VideoKind) {
        *self.slot(kind) = ShareState::Idle;
    }

    /// Active → Idle, returning the published trackName. Idle/Starting → None (idempotent stop).
    pub fn stop(&mut self, kind: VideoKind) -> Option<String> {
        let slot = self.slot(kind);
        match std::mem::take(slot) {
            ShareState::Active(name) => Some(name),
            other => {
                *slot = other; // Starting stays Starting; stop of in-flight start is a no-op
                None
            }
        }
    }

    /// Reset both kinds (voice_leave).
    pub fn clear(&mut self) {
        self.screen = ShareState::Idle;
        self.webcam = ShareState::Idle;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tavern_capture::config::{plan_screen, plan_webcam};

    /// DoD: encoding-params builder exactly matches the §1 table — all screen rows × 4 fps
    /// (through `plan_screen`, same row inputs as the capture-crate 24-combo test) with rid,
    /// scale, bitrate and framerate asserted on the emitted encodings.
    #[test]
    fn screen_encodings_match_table_all_rows_all_fps() {
        // (sel_height, fps, expected h kbps, simulcast, expected l scale)
        #[rustfmt::skip]
        let cases: [(u32, u32, u32, bool, f64); 24] = [
            (1440,  15, 3000, true, 4.0), (1440,  30, 4000, true, 4.0),
            (1440,  60, 6000, true, 4.0), (1440, 120, 8000, true, 4.0),
            (1080,  15, 1900, true, 3.0), (1080,  30, 2500, true, 3.0),
            (1080,  60, 3750, true, 3.0), (1080, 120, 5000, true, 3.0),
            (720,   15, 1150, true, 2.0), (720,   30, 1500, true, 2.0),
            (720,   60, 2250, true, 2.0), (720,  120, 3000, true, 2.0),
            (480,   15,  800, false, 0.0), (480,   30,  800, false, 0.0),
            (480,   60, 1200, false, 0.0), (480,  120, 1600, false, 0.0),
            (360,   15,  400, false, 0.0), (360,   30,  500, false, 0.0),
            (360,   60,  750, false, 0.0), (360,  120, 1000, false, 0.0),
            // native on 2880×1800 → 1440-row rates, l scale 1800/360 = 5.0
            (0,     15, 3000, true, 5.0), (0,     30, 4000, true, 5.0),
            (0,     60, 6000, true, 5.0), (0,    120, 8000, true, 5.0),
        ];
        for (sel, fps, h_kbps, simulcast, l_scale) in cases {
            let (sw, sh) = if sel == 0 { (2880, 1800) } else { (5120, 2880) };
            let plan = plan_screen(sel, fps, sw, sh);
            let enc = encodings_for(&plan);
            assert_eq!(
                enc.len(),
                if simulcast { 2 } else { 1 },
                "sel={sel} fps={fps}"
            );

            let h = &enc[0];
            assert_eq!(
                h.rid,
                if simulcast { "h" } else { "" },
                "sel={sel} fps={fps}"
            );
            assert_eq!(h.scale_resolution_down_by, Some(1.0));
            assert_eq!(
                h.max_bitrate,
                Some(h_kbps as u64 * 1000),
                "sel={sel} fps={fps}"
            );
            assert_eq!(h.max_framerate, Some(fps as f64));

            if simulcast {
                let l = &enc[1];
                assert_eq!(l.rid, "l");
                assert_eq!(
                    l.scale_resolution_down_by,
                    Some(l_scale),
                    "sel={sel} fps={fps}"
                );
                // l is ALWAYS 360p@15fps @300 kbps (§1).
                assert_eq!(l.max_bitrate, Some(300_000));
                assert_eq!(l.max_framerate, Some(15.0));
            }
        }
    }

    /// Webcam rows × both fps values: 720 → h+l (900k / 180p@15@150k, scale 4.0); 480/360 single.
    #[test]
    fn webcam_encodings_match_table() {
        for fps in [15u32, 30] {
            let enc = encodings_for(&plan_webcam(1280, 720, fps));
            assert_eq!(enc.len(), 2);
            assert_eq!(
                (enc[0].rid.as_str(), enc[0].max_bitrate),
                ("h", Some(900_000))
            );
            assert_eq!(enc[0].max_framerate, Some(fps as f64));
            assert_eq!(
                (
                    enc[1].rid.as_str(),
                    enc[1].scale_resolution_down_by,
                    enc[1].max_bitrate,
                    enc[1].max_framerate
                ),
                ("l", Some(4.0), Some(150_000), Some(15.0))
            );

            let enc = encodings_for(&plan_webcam(640, 480, fps));
            assert_eq!(enc.len(), 1);
            assert_eq!(
                (enc[0].rid.as_str(), enc[0].max_bitrate),
                ("", Some(600_000))
            );

            let enc = encodings_for(&plan_webcam(640, 360, fps));
            assert_eq!(
                (enc[0].rid.as_str(), enc[0].max_bitrate),
                ("", Some(400_000))
            );
        }
    }

    /// DoD: publish/unpublish state machine — begin/mark_active/stop per kind, double-start
    /// rejected, idempotent stop, failed start rolls back, kinds independent.
    #[test]
    fn shares_state_machine() {
        let mut sm = SharesSm::default();

        // start → active → stop returns the trackName
        sm.begin(VideoKind::Screen).unwrap();
        assert!(matches!(
            sm.begin(VideoKind::Screen),
            Err(EngineError::AlreadySharing)
        ));
        sm.mark_active(VideoKind::Screen, "screen-1");
        assert!(matches!(
            sm.begin(VideoKind::Screen),
            Err(EngineError::AlreadySharing)
        ));
        assert_eq!(sm.stop(VideoKind::Screen).as_deref(), Some("screen-1"));
        // idempotent stop
        assert_eq!(sm.stop(VideoKind::Screen), None);
        // restart after stop is allowed
        sm.begin(VideoKind::Screen).unwrap();

        // failed start rolls back to Idle
        sm.abort(VideoKind::Screen);
        sm.begin(VideoKind::Screen).unwrap();
        sm.mark_active(VideoKind::Screen, "screen-2");

        // kinds are independent: webcam can start while screen is active
        sm.begin(VideoKind::Webcam).unwrap();
        sm.mark_active(VideoKind::Webcam, "webcam-1");
        assert_eq!(sm.stop(VideoKind::Webcam).as_deref(), Some("webcam-1"));
        assert_eq!(sm.stop(VideoKind::Screen).as_deref(), Some("screen-2"));

        // stop during Starting is a no-op (the in-flight start owns the teardown)
        sm.begin(VideoKind::Webcam).unwrap();
        assert_eq!(sm.stop(VideoKind::Webcam), None);
        sm.mark_active(VideoKind::Webcam, "webcam-2");
        sm.clear();
        assert_eq!(sm.stop(VideoKind::Webcam), None);
        sm.begin(VideoKind::Webcam).unwrap(); // clear resets Starting/Active alike
    }

    /// DoD: the share-cap 409 maps to the typed `share_limit` engine event; other errors don't.
    #[test]
    fn share_limit_maps_to_typed_event() {
        let e = EngineError::Signaling(SignalError::Http {
            status: 409,
            code: Some("share_limit".into()),
        });
        assert_eq!(error_event_code(&e), Some("share_limit"));

        for other in [
            EngineError::Signaling(SignalError::Http {
                status: 403,
                code: Some("not_in_voice".into()),
            }),
            EngineError::Signaling(SignalError::Http {
                status: 409,
                code: None,
            }),
            EngineError::Media("x".into()),
            EngineError::AlreadySharing,
        ] {
            assert_eq!(error_event_code(&other), None, "{other:?}");
        }
    }
}
