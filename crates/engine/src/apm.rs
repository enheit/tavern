//! Audio processing (AEC / NS / AGC / HPF). PLAN §1 makes the APM mandatory in both audio
//! branches: the playout mix passes `process_reverse_stream` (the AEC reference) right before
//! the output device, and captured mic frames pass `process_stream` right after.
//!
//! The [`Apm`] trait is the seam the [`crate::pipeline`] drives, so tests can inject an
//! instrumented double (count/ordering assertions) without real libwebrtc. [`RealApm`] wraps
//! libwebrtc's `AudioProcessingModule` for production.

/// Audio sample rate the engine runs the APM at (libwebrtc's native rate). One 10 ms frame is
/// `HZ / 100` samples per channel.
pub const APM_HZ: i32 = 48_000;

/// Errors from the audio-processing stage.
#[derive(Debug)]
pub struct ApmError(pub String);

impl std::fmt::Display for ApmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "apm: {}", self.0)
    }
}
impl std::error::Error for ApmError {}

/// The audio-processing surface the pipeline needs. In-place processing of a slice whose length
/// is a whole number of 10 ms frames (`sample_rate/100 * num_channels` samples each).
pub trait Apm: Send {
    /// AEC far-end reference: the mix about to be played out.
    fn process_reverse_stream(
        &mut self,
        data: &mut [i16],
        sample_rate: i32,
        num_channels: i32,
    ) -> Result<(), ApmError>;

    /// Captured near-end (mic) frame, processed after the matching reverse call.
    fn process_stream(
        &mut self,
        data: &mut [i16],
        sample_rate: i32,
        num_channels: i32,
    ) -> Result<(), ApmError>;
}

/// libwebrtc `AudioProcessingModule` (full AEC3 + NS + AGC + HPF).
pub struct RealApm {
    inner: libwebrtc::native::apm::AudioProcessingModule,
}

impl RealApm {
    /// AEC + AGC + HPF + NS all on (the mandatory full chain per §1).
    pub fn new() -> Self {
        Self {
            inner: libwebrtc::native::apm::AudioProcessingModule::new(true, true, true, true),
        }
    }
}

impl Default for RealApm {
    fn default() -> Self {
        Self::new()
    }
}

impl Apm for RealApm {
    fn process_reverse_stream(
        &mut self,
        data: &mut [i16],
        sample_rate: i32,
        num_channels: i32,
    ) -> Result<(), ApmError> {
        self.inner
            .process_reverse_stream(data, sample_rate, num_channels)
            .map_err(|e| ApmError(e.message))
    }

    fn process_stream(
        &mut self,
        data: &mut [i16],
        sample_rate: i32,
        num_channels: i32,
    ) -> Result<(), ApmError> {
        self.inner
            .process_stream(data, sample_rate, num_channels)
            .map_err(|e| ApmError(e.message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DoD: APM smoke — 1 s of 440 Hz sine through the real APM is not a passthrough. The APM is
    /// pure DSP (no audio device), so it runs on every OS once libwebrtc links.
    #[test]
    fn real_apm_alters_a_sine() {
        let mut apm = RealApm::new();
        let frame = (APM_HZ / 100) as usize; // 480 samples = 10 ms mono
        let step = 2.0 * std::f32::consts::PI * 440.0 / APM_HZ as f32;
        let mut phase = 0.0f32;
        let mut changed = 0usize;
        let mut total = 0usize;
        // 100 frames = 1 s. NS/AGC/HPF alter a clean tone; assert a meaningful fraction moves.
        for _ in 0..100 {
            let mut buf = vec![0i16; frame];
            for s in buf.iter_mut() {
                *s = (phase.sin() * 0.3 * i16::MAX as f32) as i16;
                phase += step;
                if phase > 2.0 * std::f32::consts::PI {
                    phase -= 2.0 * std::f32::consts::PI;
                }
            }
            let before = buf.clone();
            apm.process_stream(&mut buf, APM_HZ, 1).unwrap();
            changed += before.iter().zip(&buf).filter(|(a, b)| a != b).count();
            total += frame;
        }
        assert!(
            changed > total / 10,
            "APM was ~passthrough: {changed}/{total} samples changed"
        );
    }

    /// The reverse (far-end/AEC-reference) path accepts a whole 10 ms frame without error.
    #[test]
    fn real_apm_reverse_stream_ok() {
        let mut apm = RealApm::default();
        let mut frame = vec![1_000i16; (APM_HZ / 100) as usize];
        apm.process_reverse_stream(&mut frame, APM_HZ, 1).unwrap();
    }

    #[test]
    fn apm_error_displays() {
        let e = ApmError("boom".into());
        assert_eq!(e.to_string(), "apm: boom");
    }
}
