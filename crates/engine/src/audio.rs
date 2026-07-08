//! Device I/O + the 10 ms driver that runs [`crate::pipeline::AudioPipeline`] live: cpal input
//! feeds a capture ring, per-owner remote rings are filled by `NativeAudioStream` tasks, and the
//! driver mixes + APM-processes + publishes the mic + fills the cpal output ring every 10 ms.
//!
//! This is device glue: it can only be exercised end-to-end against real hardware + the SFU, which
//! is S4.3 (P6). The tested logic lives in [`crate::pipeline`]/[`crate::mixer`]; this module keeps
//! the plumbing thin. `// ponytail:` marks known-ceiling shortcuts to revisit on real hardware.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use libwebrtc::audio_frame::AudioFrame;
use libwebrtc::audio_source::native::NativeAudioSource;

use crate::apm::Apm;
use crate::mixer::MixSource;
use crate::pipeline::{AudioPipeline, MicState, FRAME_SAMPLES, SAMPLE_RATE};

/// A simple sample FIFO shared between an audio callback and the driver. `// ponytail:` a
/// `Mutex<VecDeque>` — critical sections are a few hundred samples every 10 ms, so contention is
/// negligible at Tavern's 5×10 scale; swap for a lock-free ring (rtrb) only if xruns show up.
pub type Ring = Arc<Mutex<VecDeque<i16>>>;

fn new_ring() -> Ring {
    Arc::new(Mutex::new(VecDeque::with_capacity(SAMPLE_RATE as usize)))
}

/// Pop exactly `n` samples, zero-filling on underrun (glitch instead of stall).
fn pop_frame(ring: &Ring, n: usize) -> Vec<i16> {
    let mut r = ring.lock().unwrap();
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(r.pop_front().unwrap_or(0));
    }
    out
}

/// Per-owner decoded-PCM rings (filled by `NativeAudioStream` tasks), plus per-user gains.
#[derive(Clone, Default)]
pub struct RemoteMix {
    rings: Arc<Mutex<HashMap<String, Ring>>>,
    gains: Arc<Mutex<HashMap<String, f32>>>,
}

impl RemoteMix {
    /// Get (or create) the ring an owner's playout task pushes decoded PCM into.
    pub fn ring_for(&self, owner_id: &str) -> Ring {
        let mut m = self.rings.lock().unwrap();
        m.entry(owner_id.to_string())
            .or_insert_with(new_ring)
            .clone()
    }
    pub fn remove(&self, owner_id: &str) {
        self.rings.lock().unwrap().remove(owner_id);
    }
    pub fn set_gain(&self, user_id: &str, gain: f32) {
        self.gains.lock().unwrap().insert(user_id.to_string(), gain);
    }
    pub fn clear(&self) {
        self.rings.lock().unwrap().clear();
    }
    fn gain(&self, user_id: &str) -> f32 {
        self.gains
            .lock()
            .unwrap()
            .get(user_id)
            .copied()
            .unwrap_or(1.0)
    }
    /// Drain one 10 ms frame from every ring, paired with the owner's gain.
    fn drain_frame(&self) -> Vec<(String, Vec<i16>, f32)> {
        let rings: Vec<(String, Ring)> = self
            .rings
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        rings
            .into_iter()
            .map(|(owner, ring)| {
                let g = self.gain(&owner);
                (owner.clone(), pop_frame(&ring, FRAME_SAMPLES), g)
            })
            .collect()
    }
}

/// One decoded-audio RMS reading per user (self + each remote), 0.0–1.0. Emitted at 10 Hz.
#[derive(Clone, Debug)]
pub struct Level {
    pub user_id: String,
    pub rms: f32,
}

fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sumsq: f64 = samples
        .iter()
        .map(|&s| (s as f64 / i16::MAX as f64).powi(2))
        .sum();
    (sumsq / samples.len() as f64).sqrt() as f32
}

/// The live 10 ms driver. Owns the APM (via the pipeline), reads the capture + remote rings, and
/// writes the playout ring + publishes the mic. Runs until `stop` is set (voice_leave).
pub struct Driver {
    pub capture: Ring,
    pub playout: Ring,
    pub remote: RemoteMix,
    pub mic_state: MicState,
    pub self_user_id: String,
    pub stop: Arc<AtomicBool>,
    pub on_levels: Option<Arc<dyn Fn(Vec<Level>) + Send + Sync>>,
}

impl Driver {
    /// Spawn the pump. `mic_source` receives processed mic frames (unless suppressed).
    pub async fn run<A: Apm + 'static>(
        self,
        mut pipe: AudioPipeline<A>,
        mic_source: NativeAudioSource,
    ) {
        let mut ticker = tokio::time::interval(Duration::from_millis(10));
        while !self.stop.load(Ordering::Relaxed) {
            ticker.tick().await;
            let mic_in = pop_frame(&self.capture, FRAME_SAMPLES);
            let remote_frames = self.remote.drain_frame();
            let sources: Vec<MixSource> = remote_frames
                .iter()
                .map(|(_, s, g)| MixSource {
                    samples: s,
                    gain: *g,
                })
                .collect();

            let out = match pipe.tick(&sources, &mic_in) {
                Ok(o) => o,
                Err(_) => continue, // APM framing error: skip this frame rather than kill voice
            };

            // Playout → output ring for the cpal callback.
            {
                let mut p = self.playout.lock().unwrap();
                p.extend(out.playout.iter().copied());
                // Bound latency: never let the output ring grow past ~200 ms.
                while p.len() > (SAMPLE_RATE as usize) / 5 {
                    p.pop_front();
                }
            }

            // Publish the processed mic frame unless muted/deafened.
            if let Some(frame) = out.mic_publish {
                let af = AudioFrame {
                    data: frame.into(),
                    sample_rate: SAMPLE_RATE as u32,
                    num_channels: 1,
                    samples_per_channel: FRAME_SAMPLES as u32,
                };
                let _ = mic_source.capture_frame(&af).await;
            }

            // RMS levels @10 Hz (self mic + each remote).
            if let Some(cb) = &self.on_levels {
                let mut levels = Vec::with_capacity(remote_frames.len() + 1);
                levels.push(Level {
                    user_id: self.self_user_id.clone(),
                    rms: rms(&mic_in),
                });
                for (owner, samples, _) in &remote_frames {
                    levels.push(Level {
                        user_id: owner.clone(),
                        rms: rms(samples),
                    });
                }
                cb(levels);
            }
        }
    }
}

/// Open the default input device and push mono-downmixed i16 samples into `capture`.
/// `// ponytail:` assumes the device runs at 48 kHz (macOS default). Non-48 kHz devices need a
/// resampler before the APM — deferred to S4.3 where real hardware surfaces it.
pub fn start_capture(capture: Ring) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let dev = host.default_input_device().ok_or("no input device")?;
    let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
    let channels = cfg.channels() as usize;
    let fmt = cfg.sample_format();
    let scfg: cpal::StreamConfig = cfg.into();
    let err = |e| eprintln!("[capture] {e}");
    let push_mono = move |mono: i16, cap: &Ring| cap.lock().unwrap().push_back(mono);
    let cap = capture.clone();
    let stream = match fmt {
        cpal::SampleFormat::F32 => dev.build_input_stream(
            scfg,
            move |data: &[f32], _: &_| {
                let mut r = cap.lock().unwrap();
                for frame in data.chunks(channels) {
                    let m = (frame.iter().sum::<f32>() / channels as f32).clamp(-1.0, 1.0);
                    r.push_back((m * i16::MAX as f32) as i16);
                }
            },
            err,
            None,
        ),
        cpal::SampleFormat::I16 => dev.build_input_stream(
            scfg,
            move |data: &[i16], _: &_| {
                let mut r = capture.lock().unwrap();
                for frame in data.chunks(channels) {
                    let m = (frame.iter().map(|&s| s as i32).sum::<i32>() / channels as i32) as i16;
                    r.push_back(m);
                }
            },
            err,
            None,
        ),
        other => return Err(format!("unsupported input format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    let _ = push_mono; // keep the helper's intent documented without an unused warning
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

/// Open the default output device and drain the mono `playout` ring, up-mixing to all channels.
/// Same 48 kHz assumption as [`start_capture`].
pub fn start_playout(playout: Ring) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let dev = host.default_output_device().ok_or("no output device")?;
    let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
    let channels = cfg.channels() as usize;
    let fmt = cfg.sample_format();
    let scfg: cpal::StreamConfig = cfg.into();
    let err = |e| eprintln!("[playout] {e}");
    let stream = match fmt {
        cpal::SampleFormat::F32 => dev.build_output_stream(
            scfg,
            move |out: &mut [f32], _: &_| {
                let mut r = playout.lock().unwrap();
                for frame in out.chunks_mut(channels) {
                    let s = r.pop_front().unwrap_or(0) as f32 / i16::MAX as f32;
                    frame.iter_mut().for_each(|x| *x = s);
                }
            },
            err,
            None,
        ),
        cpal::SampleFormat::I16 => dev.build_output_stream(
            scfg,
            move |out: &mut [i16], _: &_| {
                let mut r = playout.lock().unwrap();
                for frame in out.chunks_mut(channels) {
                    let s = r.pop_front().unwrap_or(0);
                    frame.iter_mut().for_each(|x| *x = s);
                }
            },
            err,
            None,
        ),
        other => return Err(format!("unsupported output format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

/// Make the pair of rings the driver + cpal streams share.
pub fn device_rings() -> (Ring, Ring) {
    (new_ring(), new_ring())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pop_frame_zero_fills_on_underrun() {
        let r = new_ring();
        r.lock().unwrap().extend([1i16, 2, 3]);
        let f = pop_frame(&r, 5);
        assert_eq!(f, vec![1, 2, 3, 0, 0]);
    }

    #[test]
    fn remote_mix_default_gain_is_unity_and_settable() {
        let rm = RemoteMix::default();
        assert_eq!(rm.gain("bob"), 1.0);
        rm.set_gain("bob", 0.5);
        assert_eq!(rm.gain("bob"), 0.5);
    }

    #[test]
    fn drain_frame_pairs_owner_gain_and_pcm() {
        let rm = RemoteMix::default();
        rm.ring_for("bob")
            .lock()
            .unwrap()
            .extend([100i16; FRAME_SAMPLES]);
        rm.set_gain("bob", 2.0);
        let frames = rm.drain_frame();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0, "bob");
        assert_eq!(frames[0].1.len(), FRAME_SAMPLES);
        assert_eq!(frames[0].2, 2.0);
    }

    #[test]
    fn rms_of_silence_is_zero_and_tone_positive() {
        assert_eq!(rms(&[0; 480]), 0.0);
        assert!(rms(&[16_000; 480]) > 0.0);
    }
}
