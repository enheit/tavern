//! The 10 ms audio pump (PLAN §1, fixed order): mix remote PCM with per-user gain and the master
//! (deafen) gain → `process_reverse_stream` (the AEC far-end reference) → hand the frame to the
//! output device; then the just-captured mic frame → `process_stream` → publish (unless muted or
//! deafened). Reverse ALWAYS precedes the matching capture-process so AEC has the playout signal.
//!
//! [`AudioPipeline::tick`] is the pure, device-free core (one 10 ms frame). The real driver in
//! [`crate::audio`] calls it on a 10 ms cadence wired to cpal + libwebrtc; the DoD tests call it
//! directly with synthetic frames and an instrumented [`Apm`] double.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::apm::{Apm, ApmError};
use crate::mixer::{self, MixSource};

/// Engine audio rate (libwebrtc native) and framing. One 10 ms mono frame = 480 samples.
pub const SAMPLE_RATE: i32 = 48_000;
pub const CHANNELS: i32 = 1;
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 100) * CHANNELS as usize;

/// Shared mic/deafen flags. Deafen (§1) silences all output AND suppresses the mic publish; it
/// never clears `muted`, so undeafen restores the prior mic state for free (suppress = mic OR
/// deafen). Cloned into the pump task and toggled from the engine command handlers.
#[derive(Clone, Default)]
pub struct MicState {
    pub muted: Arc<AtomicBool>,
    pub deafened: Arc<AtomicBool>,
}

impl MicState {
    /// Mic publish is suppressed while muted or deafened.
    pub fn suppressed(&self) -> bool {
        self.muted.load(Ordering::Relaxed) || self.deafened.load(Ordering::Relaxed)
    }
    /// Master output gain: 0 while deafened, else unity.
    pub fn master_gain(&self) -> f32 {
        if self.deafened.load(Ordering::Relaxed) {
            0.0
        } else {
            1.0
        }
    }
    pub fn set_muted(&self, v: bool) {
        self.muted.store(v, Ordering::Relaxed);
    }
    pub fn set_deafened(&self, v: bool) {
        self.deafened.store(v, Ordering::Relaxed);
    }
}

/// One tick's outputs: the reverse-processed frame to play out, and the processed mic frame to
/// publish (`None` when suppressed).
pub struct TickOut {
    pub playout: Vec<i16>,
    pub mic_publish: Option<Vec<i16>>,
}

/// The audio pump over an [`Apm`]. Generic so tests can inject a spy/no-op APM.
pub struct AudioPipeline<A: Apm> {
    apm: A,
    mic: MicState,
}

impl<A: Apm> AudioPipeline<A> {
    pub fn new(apm: A, mic: MicState) -> Self {
        Self { apm, mic }
    }

    /// Process one 10 ms frame in the fixed order: mix → reverse → capture-process → publish.
    /// `captured_mic` is truncated/zero-padded to one frame.
    pub fn tick(
        &mut self,
        remote: &[MixSource],
        captured_mic: &[i16],
    ) -> Result<TickOut, ApmError> {
        // 1. Mix remote (deafen ⇒ master gain 0 ⇒ silence).
        let mut playout = mixer::mix(remote, self.mic.master_gain(), FRAME_SAMPLES);
        // 2. Reverse stream (AEC far-end reference) BEFORE the frame reaches the output device.
        self.apm
            .process_reverse_stream(&mut playout, SAMPLE_RATE, CHANNELS)?;
        // 3. Capture-process the mic AFTER the matching reverse call.
        let mut mic = vec![0i16; FRAME_SAMPLES];
        let n = captured_mic.len().min(FRAME_SAMPLES);
        mic[..n].copy_from_slice(&captured_mic[..n]);
        self.apm.process_stream(&mut mic, SAMPLE_RATE, CHANNELS)?;
        // 4. Publish unless muted or deafened.
        let mic_publish = if self.mic.suppressed() {
            None
        } else {
            Some(mic)
        };
        Ok(TickOut {
            playout,
            mic_publish,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records the order of APM calls: 'r' = reverse, 'f' = forward. Leaves data untouched.
    #[derive(Clone, Default)]
    struct SpyApm {
        log: Arc<Mutex<Vec<char>>>,
    }
    impl Apm for SpyApm {
        fn process_reverse_stream(
            &mut self,
            _d: &mut [i16],
            _sr: i32,
            _ch: i32,
        ) -> Result<(), ApmError> {
            self.log.lock().unwrap().push('r');
            Ok(())
        }
        fn process_stream(&mut self, _d: &mut [i16], _sr: i32, _ch: i32) -> Result<(), ApmError> {
            self.log.lock().unwrap().push('f');
            Ok(())
        }
    }

    fn tone(len: usize, amp: i16) -> Vec<i16> {
        (0..len)
            .map(|i| if i % 2 == 0 { amp } else { -amp })
            .collect()
    }

    /// DoD: reverse-stream wiring — ≥90 `process_reverse_stream` calls over 1 s (100×10 ms) of
    /// synthetic playout, and every capture-process is ordered AFTER its reverse call.
    #[test]
    fn reverse_precedes_capture_every_tick() {
        let spy = SpyApm::default();
        let log = spy.log.clone();
        let mut pipe = AudioPipeline::new(spy, MicState::default());
        let remote = [MixSource {
            samples: &tone(FRAME_SAMPLES, 8_000),
            gain: 1.0,
        }];
        let mic = tone(FRAME_SAMPLES, 4_000);
        for _ in 0..100 {
            pipe.tick(&remote, &mic).unwrap();
        }
        let log = log.lock().unwrap();
        let reverse_calls = log.iter().filter(|&&c| c == 'r').count();
        assert!(reverse_calls >= 90, "reverse calls {reverse_calls} < 90");
        // Every tick is exactly reverse-then-forward: the log is r,f,r,f,…
        assert_eq!(log.len(), 200);
        for pair in log.chunks(2) {
            assert_eq!(
                pair,
                ['r', 'f'],
                "capture processed before reverse in some tick"
            );
        }
    }

    /// A no-op APM that passes audio through unchanged, so we can assert suppression + silence.
    struct NoopApm;
    impl Apm for NoopApm {
        fn process_reverse_stream(
            &mut self,
            _d: &mut [i16],
            _sr: i32,
            _ch: i32,
        ) -> Result<(), ApmError> {
            Ok(())
        }
        fn process_stream(&mut self, _d: &mut [i16], _sr: i32, _ch: i32) -> Result<(), ApmError> {
            Ok(())
        }
    }

    /// DoD: deafen — mic frames stop reaching the sender while deafened, and undeafen restores the
    /// prior mic state (here: unmuted → publishing resumes). Playout is silenced while deafened.
    #[test]
    fn deafen_suppresses_mic_and_output_then_restores() {
        let mic = MicState::default();
        let mut pipe = AudioPipeline::new(NoopApm, mic.clone());
        let remote = [MixSource {
            samples: &tone(FRAME_SAMPLES, 10_000),
            gain: 1.0,
        }];
        let captured = tone(FRAME_SAMPLES, 5_000);

        // Baseline: mic publishes, output has audio.
        let out = pipe.tick(&remote, &captured).unwrap();
        assert!(out.mic_publish.is_some());
        assert!(out.playout.iter().any(|&s| s != 0));

        // Deafen: mic suppressed, output silenced.
        mic.set_deafened(true);
        let out = pipe.tick(&remote, &captured).unwrap();
        assert!(
            out.mic_publish.is_none(),
            "mic still reaching sender while deafened"
        );
        assert!(
            out.playout.iter().all(|&s| s == 0),
            "output not silenced while deafened"
        );

        // Undeafen: prior (unmuted) mic state restored.
        mic.set_deafened(false);
        let out = pipe.tick(&remote, &captured).unwrap();
        assert!(out.mic_publish.is_some(), "mic not restored after undeafen");
    }

    /// Deafen does not clobber an explicit mute: mute → deafen → undeafen leaves the mic muted.
    #[test]
    fn undeafen_preserves_prior_mute() {
        let mic = MicState::default();
        let mut pipe = AudioPipeline::new(NoopApm, mic.clone());
        let captured = tone(FRAME_SAMPLES, 5_000);
        mic.set_muted(true);
        mic.set_deafened(true);
        assert!(pipe.tick(&[], &captured).unwrap().mic_publish.is_none());
        mic.set_deafened(false);
        // Still muted from before the deafen.
        assert!(pipe.tick(&[], &captured).unwrap().mic_publish.is_none());
    }
}
