//! S1.6 (a) — audio capture-path decision spike (P4 audio). Throwaway.
//!
//! §1 decides "capture only": libwebrtc ADM if its round-trip gates pass, else cpal capture.
//! Remote playout is ALWAYS engine-owned (cpal) — so here a 440 Hz tone is played via cpal
//! output (the engine-owned playout + the test signal), and TWO capture paths are measured:
//!   A) libwebrtc ADM: acquire_platform_adm → init/start_recording → create_device_audio_track
//!      → NativeAudioStream → mic PCM → RMS.
//!   B) cpal input: default mic → RMS.
//! Decision: ADM if {admInitOk, playoutErrors==0, captureRmsDbfs > -50} all pass, else cpal.
//!
//!   run (from spikes/capture): cargo run --release --bin audio
//!
//! Writes audio.json {admInitOk, playoutErrors, captureRmsDbfs, decision, …}. The RMS gate is
//! local/manual: it needs a mic (Microphone TCC grant) and an audible source.

use std::f32::consts::PI;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::StreamExt;
use libwebrtc::audio_stream::native::NativeAudioStream;
use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use libwebrtc::peer_connection_factory::PeerConnectionFactory;
use serde_json::json;

fn dbfs(sum_sq: f64, n: u64) -> f64 {
    if n == 0 {
        return -120.0;
    }
    let rms = (sum_sq / n as f64).sqrt();
    if rms <= 1e-9 {
        -120.0
    } else {
        20.0 * rms.log10()
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results/audio.json");
    let host = cpal::default_host();

    // ---- Engine-owned playout: 440 Hz tone via cpal output (also the capture test signal). ----
    let out_dev = host.default_output_device().ok_or("no default output device")?;
    let out_cfg = out_dev.default_output_config()?;
    if out_cfg.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("cpal out format {:?} != f32", out_cfg.sample_format()).into());
    }
    let out_ch = out_cfg.channels() as usize;
    let out_sr = out_cfg.sample_rate() as f32;
    let playout_errors = Arc::new(AtomicU64::new(0));
    let tone_stream = {
        let pe = playout_errors.clone();
        let mut phase = 0f32;
        let step = 2.0 * PI * 440.0 / out_sr;
        let scfg: cpal::StreamConfig = out_cfg.clone().into();
        out_dev.build_output_stream(
            scfg,
            move |o: &mut [f32], _: &cpal::OutputCallbackInfo| {
                for frame in o.chunks_mut(out_ch) {
                    let s = phase.sin() * 0.25;
                    phase += step;
                    if phase > 2.0 * PI {
                        phase -= 2.0 * PI;
                    }
                    for x in frame.iter_mut() {
                        *x = s;
                    }
                }
            },
            move |_e| {
                pe.fetch_add(1, Ordering::Relaxed);
            },
            None,
        )?
    };
    tone_stream.play()?;
    eprintln!("[playout] 440 Hz tone playing (cpal, engine-owned)");

    // ---- Capture path A: libwebrtc ADM (device audio track → NativeAudioStream PCM). ----
    let factory = PeerConnectionFactory::default();
    let adm_init_ok = factory.acquire_platform_adm();
    let recording_init_ok = adm_init_ok && factory.init_recording() && factory.start_recording();
    eprintln!("[adm] acquire={adm_init_ok} recording_init={recording_init_ok}");
    let (adm_frames, adm_sumsq, adm_samples) = if recording_init_ok {
        let track = factory.create_device_audio_track("mic-probe");
        let mut stream = Box::pin(NativeAudioStream::new(track, 48_000, 1));
        let mut frames = 0u64;
        let mut sumsq = 0f64;
        let mut samples = 0u64;
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(f) = stream.next().await {
                frames += 1;
                for &s in f.data.iter() {
                    let v = s as f64 / i16::MAX as f64;
                    sumsq += v * v;
                    samples += 1;
                }
            }
        })
        .await;
        (frames, sumsq, samples)
    } else {
        (0, 0.0, 0)
    };
    factory.release_platform_adm();
    let adm_rms_dbfs = dbfs(adm_sumsq, adm_samples);
    eprintln!("[adm] frames={adm_frames} samples={adm_samples} rms={adm_rms_dbfs:.1} dBFS");

    // ---- Capture path B: cpal input (default mic). ----
    let in_dev = host.default_input_device().ok_or("no default input device")?;
    let in_cfg = in_dev.default_input_config()?;
    let in_ch = in_cfg.channels() as usize;
    let in_fmt = in_cfg.sample_format();
    let in_scfg: cpal::StreamConfig = in_cfg.clone().into();
    let cpal_sumsq = Arc::new(Mutex::new(0f64));
    let cpal_samples = Arc::new(AtomicU64::new(0));
    let (ss, sn) = (cpal_sumsq.clone(), cpal_samples.clone());
    let in_stream = match in_fmt {
        cpal::SampleFormat::F32 => in_dev.build_input_stream(
            in_scfg,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let acc: f64 = data.iter().map(|&s| (s as f64) * (s as f64)).sum();
                *ss.lock().unwrap() += acc;
                sn.fetch_add(data.len() as u64, Ordering::Relaxed);
            },
            |_e| {},
            None,
        )?,
        cpal::SampleFormat::I16 => in_dev.build_input_stream(
            in_scfg,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let acc: f64 = data.iter().map(|&s| { let v = s as f64 / i16::MAX as f64; v * v }).sum();
                *ss.lock().unwrap() += acc;
                sn.fetch_add(data.len() as u64, Ordering::Relaxed);
            },
            |_e| {},
            None,
        )?,
        other => return Err(format!("cpal in format {other:?} unsupported").into()),
    };
    in_stream.play()?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    drop(in_stream);
    let cpal_n = cpal_samples.load(Ordering::Relaxed);
    let cpal_rms_dbfs = dbfs(*cpal_sumsq.lock().unwrap(), cpal_n);
    eprintln!("[cpal-in] samples={cpal_n} rms={cpal_rms_dbfs:.1} dBFS ({in_ch}ch {in_fmt:?})");

    drop(tone_stream);
    let pe = playout_errors.load(Ordering::Relaxed);

    // ---- Decision (§1): ADM if its round-trip gates pass, else cpal. ----
    let adm_ok = adm_init_ok && recording_init_ok && adm_frames > 0 && adm_rms_dbfs > -50.0 && pe == 0;
    let cpal_ok = cpal_n > 0 && cpal_rms_dbfs > -50.0 && pe == 0;
    let (decision, capture_rms) = if adm_ok {
        ("ADM", adm_rms_dbfs)
    } else if cpal_ok {
        ("cpal", cpal_rms_dbfs)
    } else {
        ("cpal(env-limited)", cpal_rms_dbfs.max(adm_rms_dbfs))
    };
    let pass = adm_ok || cpal_ok;
    let r = |x: f64| (x * 10.0).round() / 10.0;

    let result = json!({
        "step": "S1.6/audio-capture-decision", "gate": "P4(audio)",
        "playout": { "branch": "cpal (engine-owned)", "toneHz": 440, "playoutErrors": pe },
        "adm": { "admInitOk": adm_init_ok, "recordingInitOk": recording_init_ok, "framesFromAdm": adm_frames, "captureRmsDbfs": r(adm_rms_dbfs) },
        "cpal": { "samples": cpal_n, "captureRmsDbfs": r(cpal_rms_dbfs), "channels": in_ch, "format": format!("{in_fmt:?}") },
        "decision": decision, "captureRmsDbfs": r(capture_rms),
        "gates": { "admInitOk": adm_init_ok, "playoutErrorsZero": pe == 0, "captureRmsAboveMinus50": capture_rms > -50.0 },
        "pass": pass,
        "note": if pass { "".to_string() } else {
            "captureRmsDbfs ≤ -50: no mic signal (silence / Microphone TCC not granted / no audible source). This gate is local/manual per the plan — grant Microphone access and ensure an audible source, then re-run.".to_string()
        }
    });
    std::fs::write(out, serde_json::to_string_pretty(&result)?)?;
    println!(
        "audio: decision={decision} admInitOk={adm_init_ok} admFrames={adm_frames} admRms={adm_rms_dbfs:.1} cpalRms={cpal_rms_dbfs:.1} playoutErrors={pe} → {}",
        if pass { "PASS" } else { "FAIL(env-limited)" }
    );
    Ok(())
}
