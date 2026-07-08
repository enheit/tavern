//! §1 simulcast/bitrate tables (fixed) — resolution mapping incl. native bucketing.
//!
//! Screen: `h` layer at the (clamped) selected resolution; `l` ALWAYS 360p@15fps@300kbps on
//! simulcast rows. Listed `h` bitrates are for 30 fps; fps multiplier applies to `h` only
//! (15→×0.75, 30→×1.0, 60→×1.5, 120→×2.0), rounded to the nearest 50 kbps (ties away from
//! zero, `f64::round`). The 480p row floors the multiplier at 1.0 (never below 800 kbps).
//! Native buckets by captured height: ≥1350→1440 row, ≥900→1080, ≥600→720, else the 480 row.
//! Webcam: 720→h+l (900 kbps / 180p@15@150), 480→single 600, 360→single 400; fps-independent.

/// One encoder layer. `width`×`height` are even (I420).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layer {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub max_kbps: u32,
}

/// Encoding plan for a capture: frames are emitted at `h` dims; `l` (present iff simulcast)
/// is encoder-downscaled from them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncodingPlan {
    pub h: Layer,
    pub l: Option<Layer>,
}

impl EncodingPlan {
    pub fn simulcast(&self) -> bool {
        self.l.is_some()
    }
}

fn fps_mult(fps: u32) -> f64 {
    match fps {
        15 => 0.75,
        60 => 1.5,
        120 => 2.0,
        _ => 1.0, // 30 (and defensive default)
    }
}

/// Round to the nearest 50 kbps; .5 ties away from zero (`f64::round`).
fn round50(kbps: f64) -> u32 {
    ((kbps / 50.0).round() * 50.0) as u32
}

fn even(x: u32) -> u32 {
    x & !1
}

/// Aspect-preserving width for a target height, rounded then even-floored.
fn width_for_height(src_w: u32, src_h: u32, target_h: u32) -> u32 {
    even(((src_w as u64 * target_h as u64) as f64 / src_h as f64).round() as u32)
}

/// §1 screen table. `sel_height` 0 = native; a selection ≥ the source height also degrades to
/// native (no upscaling). `src_w`×`src_h` are the raw captured dims.
pub fn plan_screen(sel_height: u32, fps: u32, src_w: u32, src_h: u32) -> EncodingPlan {
    let native = sel_height == 0 || sel_height >= src_h;
    let (w, h) = if native {
        (even(src_w), even(src_h))
    } else {
        (width_for_height(src_w, src_h, sel_height), sel_height)
    };
    // Row selection: explicit selections use their row; native buckets by captured height.
    let row = if native {
        match src_h {
            x if x >= 1350 => 1440,
            x if x >= 900 => 1080,
            x if x >= 600 => 720,
            _ => 480,
        }
    } else {
        sel_height
    };
    let (base_kbps, simulcast, floor_mult) = match row {
        1440 => (4000.0, true, false),
        1080 => (2500.0, true, false),
        720 => (1500.0, true, false),
        480 => (800.0, false, true),
        _ => (500.0, false, false), // 360
    };
    let mult = if floor_mult {
        fps_mult(fps).max(1.0)
    } else {
        fps_mult(fps)
    };
    let h_layer = Layer {
        width: w,
        height: h,
        fps,
        max_kbps: round50(base_kbps * mult),
    };
    let l_layer = simulcast.then(|| Layer {
        width: width_for_height(w, h, 360),
        height: 360,
        fps: 15,
        max_kbps: 300,
    });
    EncodingPlan {
        h: h_layer,
        l: l_layer,
    }
}

/// §1 webcam table (bitrates fps-independent). `cfg_h` ∈ {360, 480, 720} per §0.
pub fn plan_webcam(cfg_w: u32, cfg_h: u32, fps: u32) -> EncodingPlan {
    let (w, h) = (even(cfg_w), even(cfg_h));
    let (kbps, simulcast) = match cfg_h {
        720 => (900, true),
        480 => (600, false),
        _ => (400, false), // 360
    };
    let l = simulcast.then(|| Layer {
        width: width_for_height(w, h, 180),
        height: 180,
        fps: 15,
        max_kbps: 150,
    });
    EncodingPlan {
        h: Layer {
            width: w,
            height: h,
            fps,
            max_kbps: kbps,
        },
        l,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const L360: Layer = Layer {
        width: 640,
        height: 360,
        fps: 15,
        max_kbps: 300,
    };

    /// DoD: ALL §1 screen rows × 4 fps values = 24 combos (5 explicit rows on a 5120×2880
    /// source + native on 2880×1800), asserting layers + h-bitrate after the fps multiplier.
    #[test]
    fn screen_table_all_rows_x_all_fps() {
        // (sel_height, fps, expect_simulcast, expect_h_kbps, expect_w, expect_h)
        #[rustfmt::skip]
        let cases: [(u32, u32, bool, u32, u32, u32); 24] = [
            // 1440 row: 4000 @30 → ×0.75=3000, ×1.5=6000, ×2.0=8000
            (1440,  15, true,  3000, 2560, 1440),
            (1440,  30, true,  4000, 2560, 1440),
            (1440,  60, true,  6000, 2560, 1440),
            (1440, 120, true,  8000, 2560, 1440),
            // 1080 row: 2500 @30 → 1875 rounds to 1900 (nearest 50, tie away from zero)
            (1080,  15, true,  1900, 1920, 1080),
            (1080,  30, true,  2500, 1920, 1080),
            (1080,  60, true,  3750, 1920, 1080),
            (1080, 120, true,  5000, 1920, 1080),
            // 720 row: 1500 @30 → 1125 rounds to 1150
            (720,   15, true,  1150, 1280, 720),
            (720,   30, true,  1500, 1280, 720),
            (720,   60, true,  2250, 1280, 720),
            (720,  120, true,  3000, 1280, 720),
            // 480 row: single, multiplier floored at 1.0 (never below 800)
            (480,   15, false,  800,  852, 480),
            (480,   30, false,  800,  852, 480),
            (480,   60, false, 1200,  852, 480),
            (480,  120, false, 1600,  852, 480),
            // 360 row: single, full fps rule (375 rounds to 400)
            (360,   15, false,  400,  640, 360),
            (360,   30, false,  500,  640, 360),
            (360,   60, false,  750,  640, 360),
            (360,  120, false, 1000,  640, 360),
            // native row on a 2880×1800 source: buckets ≥1350 → 1440-row rates, h = source dims
            (0,     15, true,  3000, 2880, 1800),
            (0,     30, true,  4000, 2880, 1800),
            (0,     60, true,  6000, 2880, 1800),
            (0,    120, true,  8000, 2880, 1800),
        ];
        for (sel, fps, simulcast, kbps, w, h) in cases {
            let (src_w, src_h) = if sel == 0 { (2880, 1800) } else { (5120, 2880) };
            let plan = plan_screen(sel, fps, src_w, src_h);
            assert_eq!(plan.simulcast(), simulcast, "sel={sel} fps={fps}");
            assert_eq!(
                plan.h,
                Layer {
                    width: w,
                    height: h,
                    fps,
                    max_kbps: kbps
                },
                "sel={sel} fps={fps}"
            );
            if simulcast {
                let l = plan.l.unwrap();
                // l is ALWAYS 360p@15@300; width follows the h aspect.
                assert_eq!(
                    (l.height, l.fps, l.max_kbps),
                    (360, 15, 300),
                    "sel={sel} fps={fps}"
                );
                assert_eq!(l.width, width_for_height(w, h, 360), "sel={sel} fps={fps}");
            } else {
                assert_eq!(plan.l, None, "sel={sel} fps={fps}");
            }
        }
        // 16:9 sources produce the canonical 640×360 l layer.
        assert_eq!(plan_screen(720, 30, 5120, 2880).l.unwrap(), L360);
        // 16:10 native: l width follows aspect (2880×1800 → 576×360).
        assert_eq!(plan_screen(0, 30, 2880, 1800).l.unwrap().width, 576);
    }

    #[test]
    fn native_bucketing_edges() {
        // ≥900 → 1080 row
        let p = plan_screen(0, 30, 1920, 1080);
        assert_eq!((p.h.max_kbps, p.simulcast()), (2500, true));
        // ≥600 → 720 row
        let p = plan_screen(0, 30, 1024, 640);
        assert_eq!((p.h.max_kbps, p.simulcast()), (1500, true));
        // <600 → single 800 with the 480-row floored multiplier
        let p = plan_screen(0, 15, 800, 500);
        assert_eq!((p.h.max_kbps, p.simulcast(), p.h.height), (800, false, 500));
        // exact thresholds
        assert_eq!(plan_screen(0, 30, 2400, 1350).h.max_kbps, 4000);
        assert_eq!(plan_screen(0, 30, 2398, 1349).h.max_kbps, 2500);
        assert_eq!(plan_screen(0, 30, 1600, 900).h.max_kbps, 2500);
        assert_eq!(plan_screen(0, 30, 1066, 600).h.max_kbps, 1500);
    }

    #[test]
    fn selection_never_upscales() {
        // Selecting 1440 on a 1080p source degrades to native semantics (1080 bucket).
        let p = plan_screen(1440, 30, 1920, 1080);
        assert_eq!(
            (p.h.width, p.h.height, p.h.max_kbps, p.simulcast()),
            (1920, 1080, 2500, true)
        );
        // Odd source dims are even-floored.
        let p = plan_screen(0, 30, 1919, 1079);
        assert_eq!((p.h.width, p.h.height), (1918, 1078));
    }

    /// §1 webcam rows × both fps values; bitrates fps-independent; 720 carries a 180p l layer.
    #[test]
    fn webcam_table() {
        for fps in [15, 30] {
            let p = plan_webcam(1280, 720, fps);
            assert_eq!(
                p.h,
                Layer {
                    width: 1280,
                    height: 720,
                    fps,
                    max_kbps: 900
                }
            );
            assert_eq!(
                p.l.unwrap(),
                Layer {
                    width: 320,
                    height: 180,
                    fps: 15,
                    max_kbps: 150
                }
            );

            let p = plan_webcam(640, 480, fps);
            assert_eq!(
                p.h,
                Layer {
                    width: 640,
                    height: 480,
                    fps,
                    max_kbps: 600
                }
            );
            assert_eq!(p.l, None);

            let p = plan_webcam(640, 360, fps);
            assert_eq!(
                p.h,
                Layer {
                    width: 640,
                    height: 360,
                    fps,
                    max_kbps: 400
                }
            );
            assert_eq!(p.l, None);
        }
    }
}
