//! Raw pixels → I420 via libwebrtc's `yuv_helper` (libyuv).
//!
//! libyuv names formats by their little-endian in-memory byte order: our BGRA bytes are
//! libyuv "ARGB", RGBA bytes are libyuv "ABGR" (verified against the S1.6 spike PNGs).

use libwebrtc::native::yuv_helper;
use libwebrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};

/// The frame type the capture crate emits — ready for `NativeVideoSource::capture_frame`.
pub type Frame = VideoFrame<I420Buffer>;

pub(crate) fn wrap(buffer: I420Buffer) -> Frame {
    // timestamp_us 0 → the video source stamps capture time itself.
    Frame {
        rotation: VideoRotation::VideoRotation0,
        timestamp_us: 0,
        frame_metadata: None,
        buffer,
    }
}

/// BGRA (row `stride` bytes) → I420 at even-floored `w`×`h` (odd edges cropped).
pub fn bgra_to_i420(bgra: &[u8], stride: u32, w: u32, h: u32) -> I420Buffer {
    convert(bgra, stride, w, h, yuv_helper::argb_to_i420)
}

/// RGBA (tightly packed unless `stride` says otherwise) → I420 at even-floored `w`×`h`.
pub fn rgba_to_i420(rgba: &[u8], stride: u32, w: u32, h: u32) -> I420Buffer {
    convert(rgba, stride, w, h, yuv_helper::abgr_to_i420)
}

type ConvertFn = fn(&[u8], u32, &mut [u8], u32, &mut [u8], u32, &mut [u8], u32, i32, i32);

fn convert(src: &[u8], stride: u32, w: u32, h: u32, f: ConvertFn) -> I420Buffer {
    let (w, h) = (w & !1, h & !1);
    let mut buf = I420Buffer::new(w, h);
    let (sy, su, sv) = buf.strides();
    let (dy, du, dv) = buf.data_mut();
    f(src, stride, dy, sy, du, su, dv, sv, w as i32, h as i32);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use libwebrtc::video_frame::VideoBuffer;

    /// FNV-1a 64 over the three planes (stride-packed, as stored).
    fn checksum(buf: &I420Buffer) -> u64 {
        let (y, u, v) = buf.data();
        let mut h: u64 = 0xcbf29ce484222325;
        for b in y.iter().chain(u).chain(v) {
            h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
        }
        h
    }

    /// Deterministic BGRA test card with per-pixel high-frequency detail.
    fn pattern(w: usize, h: usize) -> Vec<u8> {
        let mut px = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                px[i] = ((x * 3 + y * 7) & 0xff) as u8; // B
                px[i + 1] = ((x * 5 + y * 11) & 0xff) as u8; // G
                px[i + 2] = ((x * 7 + y * 13) & 0xff) as u8; // R
                px[i + 3] = 0xff;
            }
        }
        px
    }

    // Golden values derived once on macOS/aarch64 (libyuv is bit-exact across its SIMD paths;
    // if a CI arch ever disagrees, that divergence is real information — record + scope then).
    const GOLDEN_CONVERT: u64 = 0xe50ffad4f5b7d265;
    const GOLDEN_SCALE: u64 = 0x717bacd98ba2a68f;

    #[test]
    fn i420_conversion_golden_checksum() {
        let buf = bgra_to_i420(&pattern(64, 36), 64 * 4, 64, 36);
        assert_eq!((buf.width(), buf.height()), (64, 36));
        assert_eq!(checksum(&buf), GOLDEN_CONVERT, "got {:#x}", checksum(&buf));

        let mut buf = buf;
        let scaled = buf.scale(32, 18);
        assert_eq!((scaled.width(), scaled.height()), (32, 18));
        assert_eq!(
            checksum(&scaled),
            GOLDEN_SCALE,
            "got {:#x}",
            checksum(&scaled)
        );
    }

    #[test]
    fn odd_dims_crop_to_even_and_match() {
        // A 65×37 capture converts its 64×36 even region — identical to converting 64×36
        // directly (the extra column/row is cropped, stride honoured).
        let odd = bgra_to_i420(&pattern(65, 37), 65 * 4, 65, 37);
        assert_eq!((odd.width(), odd.height()), (64, 36));
        assert_eq!(checksum(&odd), GOLDEN_CONVERT);
    }

    #[test]
    fn rgba_path_differs_from_bgra_on_asymmetric_input() {
        // Same bytes interpreted as RGBA swap R/B → different luma unless R==B everywhere.
        let px = pattern(64, 36);
        assert_ne!(checksum(&rgba_to_i420(&px, 64 * 4, 64, 36)), GOLDEN_CONVERT);
    }
}
