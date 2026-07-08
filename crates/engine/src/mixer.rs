//! Playout mixing: sum per-user remote PCM with a personal gain (0–200%, §0), apply the
//! master output gain (deafen sets it to 0), and saturate to i16. Pure and device-free.

/// Personal per-user volume ceiling (200%, PLAN §0). Gains are clamped to `0.0..=MAX_USER_GAIN`.
pub const MAX_USER_GAIN: f32 = 2.0;

/// One source frame in a mix: decoded PCM plus that user's personal gain.
pub struct MixSource<'a> {
    pub samples: &'a [i16],
    pub gain: f32,
}

/// Mix `sources` into one `frame_len`-sample frame at `master_gain` (deafen ⇒ 0.0). Each source
/// is scaled by its clamped personal gain, summed in f32 headroom, then saturated to i16 — loud
/// sums clamp to the rails instead of wrapping.
pub fn mix(sources: &[MixSource], master_gain: f32, frame_len: usize) -> Vec<i16> {
    let mut acc = vec![0.0f32; frame_len];
    for s in sources {
        let g = s.gain.clamp(0.0, MAX_USER_GAIN);
        for (a, &sample) in acc.iter_mut().zip(s.samples.iter().take(frame_len)) {
            *a += sample as f32 * g;
        }
    }
    let m = master_gain.max(0.0);
    acc.into_iter().map(|v| saturate_i16(v * m)).collect()
}

/// Round to the nearest i16, clamping to the rails (no wraparound).
pub fn saturate_i16(v: f32) -> i16 {
    if v >= i16::MAX as f32 {
        i16::MAX
    } else if v <= i16::MIN as f32 {
        i16::MIN
    } else {
        v.round() as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_scales_linearly() {
        let src = [MixSource {
            samples: &[100, -100, 50],
            gain: 2.0,
        }];
        assert_eq!(mix(&src, 1.0, 3), vec![200, -200, 100]);
    }

    #[test]
    fn gain_is_clamped_to_200_percent() {
        // 5.0 requested → clamped to 2.0.
        let src = [MixSource {
            samples: &[100],
            gain: 5.0,
        }];
        assert_eq!(mix(&src, 1.0, 1), vec![200]);
    }

    #[test]
    fn sums_saturate_not_wrap() {
        let hi = [
            MixSource {
                samples: &[i16::MAX],
                gain: 1.0,
            },
            MixSource {
                samples: &[i16::MAX],
                gain: 1.0,
            },
        ];
        assert_eq!(mix(&hi, 1.0, 1), vec![i16::MAX]); // 65534 → 32767, not wrap
        let lo = [
            MixSource {
                samples: &[i16::MIN],
                gain: 1.0,
            },
            MixSource {
                samples: &[i16::MIN],
                gain: 1.0,
            },
        ];
        assert_eq!(mix(&lo, 1.0, 1), vec![i16::MIN]);
    }

    #[test]
    fn master_gain_zero_is_silence_deafen() {
        let src = [MixSource {
            samples: &[30_000, -30_000],
            gain: 2.0,
        }];
        assert_eq!(mix(&src, 0.0, 2), vec![0, 0]);
    }

    #[test]
    fn single_source_clamp_at_rails() {
        // 20000 * 2.0 = 40000 → +rail; negative symmetric.
        let src = [MixSource {
            samples: &[20_000, -20_000],
            gain: 2.0,
        }];
        assert_eq!(mix(&src, 1.0, 2), vec![i16::MAX, i16::MIN]);
    }

    #[test]
    fn empty_sources_is_silence() {
        assert_eq!(mix(&[], 1.0, 4), vec![0, 0, 0, 0]);
    }
}
