//! S1.2 — Publisher SPIKE (P1). Throwaway.
//!
//! Publishes synthetic moving color bars + a 440 Hz sine to the Cloudflare Realtime SFU
//! using native libwebrtc (LiveKit binding, =0.3.38), then measures P1 for 60 s at 1 Hz.
//!
//!   run (from spikes/sfu, with CF_APP_ID / CF_APP_SECRET in env):
//!     cargo run --bin publish -- --width 640 --height 360 --fps 30
//!
//! Writes docs/spike-results/publish.json {iceConnectedMs, framesEncoded, bytesSent,
//! pliCount, requestShapes} and exits 0 iff P1 passes (ICE ≤5 s, framesEncoded ≥1500,
//! pliCount ≤6).

use std::f32::consts::PI;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use libwebrtc::audio_frame::AudioFrame;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_source::AudioSourceOptions;
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::peer_connection::{IceConnectionState, IceGatheringState, OfferOptions};
use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use libwebrtc::peer_connection_factory::{
    ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
};
use libwebrtc::rtp_parameters::RtpEncodingParameters;
use libwebrtc::rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit};
use libwebrtc::session_description::{SdpType, SessionDescription};
use libwebrtc::stats::RtcStats;
use libwebrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_source::VideoResolution;
use serde_json::{json, Value};

const BASE: &str = "https://rtc.live.cloudflare.com/v1";
const AUDIO_HZ: u32 = 48_000; // libwebrtc native audio rate
const AUDIO_CH: u32 = 1;
const SAMPLES_10MS: usize = (AUDIO_HZ / 100) as usize; // 480 = exactly 10 ms

struct Args {
    width: u32,
    height: u32,
    fps: u64,
    duration: u64, // stats-measurement window (s)
    tail: u64,     // keep pumping this long past `duration` so a subscriber stays fed (s)
    simulcast: bool,
    out: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    let (width, height, fps) = (args.width, args.height, args.fps);
    let app_id = std::env::var("CF_APP_ID").map_err(|_| "CF_APP_ID not set")?;
    let secret = std::env::var("CF_APP_SECRET").map_err(|_| "CF_APP_SECRET not set")?;
    eprintln!(
        "[cfg] {width}x{height}@{fps}, 440 Hz sine, {}s (+{}s tail), simulcast={} → SFU app {}…",
        args.duration, args.tail, args.simulcast, &app_id[..6]
    );

    let http = reqwest::Client::new();

    // 1. Create SFU session (POST, bearer, NO body) → sessionId.
    let s_url = format!("{BASE}/apps/{app_id}/sessions/new");
    let resp = http.post(&s_url).bearer_auth(&secret).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        eprintln!("sessions/new HTTP {status}: {text}");
        std::process::exit(2);
    }
    let session: Value = serde_json::from_str(&text)?;
    let session_id = session["sessionId"].as_str().ok_or("no sessionId")?.to_string();
    eprintln!("[sfu] session created");

    // 2. Factory + PeerConnection (Cloudflare STUN, non-trickle → GatherOnce).
    let factory = PeerConnectionFactory::default();
    let config = RtcConfiguration {
        ice_servers: vec![IceServer {
            urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
            username: String::new(),
            password: String::new(),
        }],
        continual_gathering_policy: ContinualGatheringPolicy::GatherOnce,
        ice_transport_type: IceTransportsType::All,
    };
    let pc = factory.create_peer_connection(config)?;

    // Video + audio native sources (cloned handles feed the pump tasks).
    let video_source = NativeVideoSource::new(VideoResolution { width, height }, false);
    let video_track = factory.create_video_track("tavern-video", video_source.clone());
    let audio_source =
        NativeAudioSource::new(AudioSourceOptions::default(), AUDIO_HZ, AUDIO_CH, 1000);
    let audio_track = factory.create_audio_track("tavern-audio", audio_source.clone());

    // trackName = MediaStreamTrack id (matches the cloudflare/calls-examples echo pattern).
    let v_mst: MediaStreamTrack = video_track.into();
    let a_mst: MediaStreamTrack = audio_track.into();
    let v_name = v_mst.id();
    let a_name = a_mst.id();

    // Video is simulcast (2 encodings) when --simulcast: rid "h" = full res, rid "l" = /2.
    // Asciibetical ordering ("h" < "l") matches the SFU's rid priority convention.
    let video_encodings = if args.simulcast {
        vec![
            // Caps kept under the pull-side BWE (~1.7 Mbps seen on the single-encoding
            // pull) so the SFU actually forwards the high layer for preferredRid:"h";
            // a 2.5 Mbps high layer exceeded BWE and the SFU fell back to low for both.
            RtpEncodingParameters {
                rid: "h".into(),
                scale_resolution_down_by: Some(1.0),
                max_bitrate: Some(1_000_000),
                ..Default::default()
            },
            RtpEncodingParameters {
                rid: "l".into(),
                scale_resolution_down_by: Some(2.0),
                max_bitrate: Some(250_000),
                ..Default::default()
            },
        ]
    } else {
        Vec::new()
    };
    let v_tvr = pc.add_transceiver(
        v_mst,
        RtpTransceiverInit {
            direction: RtpTransceiverDirection::SendOnly,
            stream_ids: vec!["tavern-video".into()],
            send_encodings: video_encodings,
        },
    )?;
    let a_tvr = pc.add_transceiver(
        a_mst,
        RtpTransceiverInit {
            direction: RtpTransceiverDirection::SendOnly,
            stream_ids: vec!["tavern-audio".into()],
            send_encodings: Vec::new(),
        },
    )?;

    // Observers: capture first ICE-connected time + a non-trickle gather-complete signal.
    let connected_ms = std::sync::Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();
    {
        let cms = connected_ms.clone();
        pc.on_ice_connection_state_change(Some(Box::new(move |state| {
            eprintln!("[ice] connection: {state:?}");
            if matches!(state, IceConnectionState::Connected | IceConnectionState::Completed) {
                let _ = cms.compare_exchange(
                    0,
                    t0.elapsed().as_millis() as u64,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
            }
        })));
    }
    let (gather_tx, gather_rx) = tokio::sync::oneshot::channel::<()>();
    let gather_tx = Mutex::new(Some(gather_tx));
    pc.on_ice_gathering_state_change(Some(Box::new(move |state| {
        eprintln!("[ice] gathering: {state:?}");
        if matches!(state, IceGatheringState::Complete) {
            if let Some(tx) = gather_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })));

    // 3. Offer (sendonly → don't offer to receive), setLocal, wait for gather-complete.
    let offer = pc
        .create_offer(OfferOptions {
            ice_restart: false,
            offer_to_receive_audio: false,
            offer_to_receive_video: false,
        })
        .await?;
    // The binding exposes only current_local_description (null in have-local-offer), so
    // capture the offer SDP now. It carries ufrag/pwd/fingerprint but no candidates; the
    // ICE-lite SFU learns our address peer-reflexively from our connectivity checks. We
    // still wait for gather-complete so our agent has host+srflx ready before checks.
    let offer_sdp = offer.to_string();
    pc.set_local_description(offer).await?;
    if !matches!(pc.ice_gathering_state(), IceGatheringState::Complete) {
        let _ = gather_rx.await;
    }
    let v_mid = v_tvr.mid().ok_or("no video mid after SLD")?;
    let a_mid = a_tvr.mid().ok_or("no audio mid after SLD")?;

    // 4. Publish local tracks (client is offerer): POST tracks/new.
    let t_url = format!("{BASE}/apps/{app_id}/sessions/{session_id}/tracks/new");
    let tracks_req = json!({
        "sessionDescription": { "sdp": offer_sdp, "type": "offer" },
        "tracks": [
            { "location": "local", "mid": v_mid, "trackName": v_name },
            { "location": "local", "mid": a_mid, "trackName": a_name },
        ]
    });
    let resp = http.post(&t_url).bearer_auth(&secret).json(&tracks_req).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        eprintln!("tracks/new HTTP {status}: {text}");
        std::process::exit(2);
    }
    let tracks_resp: Value = serde_json::from_str(&text)?;
    if let Some(ec) = tracks_resp.get("errorCode").and_then(Value::as_str) {
        eprintln!("tracks/new errorCode={ec}: {:?}", tracks_resp.get("errorDescription"));
        std::process::exit(2);
    }
    let answer_sdp = tracks_resp["sessionDescription"]["sdp"]
        .as_str()
        .ok_or("no answer sdp")?
        .to_string();
    let requires_reneg = tracks_resp
        .get("requiresImmediateRenegotiation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    eprintln!("[sfu] tracks published, requiresImmediateRenegotiation={requires_reneg}");

    // 5. Apply the SFU answer — ICE connects off the candidates embedded in it.
    pc.set_remote_description(SessionDescription::parse(&answer_sdp, SdpType::Answer)?).await?;

    // Hand the (real) session id + track names to a subscriber via a gitignored file under
    // target/. Written early so subscribe.rs can start within the 5 s concurrent-run window.
    let handoff_path = concat!(env!("CARGO_MANIFEST_DIR"), "/target/handoff.json");
    std::fs::write(
        handoff_path,
        serde_json::to_string(&json!({
            "sessionId": session_id,
            "videoTrackName": v_name,
            "audioTrackName": a_name,
            "simulcast": args.simulcast,
        }))?,
    )?;
    eprintln!("[out] wrote handoff {handoff_path}");

    // 6. Start media pumps.
    spawn_video_pump(video_source.clone(), width, height, fps);
    spawn_audio_pump(audio_source.clone());

    // 7. Measure `duration` s at 1 Hz. Per-rid so simulcast layers are counted
    // (layersNegotiated = distinct video rids the SFU actually accepted).
    let mut layers: std::collections::HashMap<String, (u32, u64, u32)> =
        std::collections::HashMap::new();
    for sec in 1..=args.duration {
        tokio::time::sleep(Duration::from_secs(1)).await;
        match pc.get_stats().await {
            Ok(stats) => {
                for s in stats {
                    if let RtcStats::OutboundRtp(o) = s {
                        if o.stream.kind == "video" {
                            layers.insert(
                                o.outbound.rid.clone(),
                                (o.outbound.frames_encoded, o.sent.bytes_sent, o.outbound.pli_count),
                            );
                        }
                    }
                }
                let fe = layers.values().map(|v| v.0).max().unwrap_or(0);
                let pli: u32 = layers.values().map(|v| v.2).sum();
                eprintln!(
                    "[{sec:02}s] layers={} framesEncoded(max)={fe} pliCount(sum)={pli} iceMs={}",
                    layers.len(),
                    connected_ms.load(Ordering::SeqCst)
                );
            }
            Err(e) => eprintln!("[{sec:02}s] get_stats error: {e:?}"),
        }
    }
    let layers_negotiated = layers.len() as u32;
    let frames_encoded = layers.values().map(|v| v.0).max().unwrap_or(0);
    let bytes_sent: u64 = layers.values().map(|v| v.1).sum();
    let pli_count: u32 = layers.values().map(|v| v.2).sum();
    let per_layer: serde_json::Map<String, Value> = layers
        .iter()
        .map(|(rid, (f, b, p))| {
            let key = if rid.is_empty() { "(single)".to_string() } else { rid.clone() };
            (key, json!({ "framesEncoded": f, "kbps": b * 8 / 1000 / args.duration.max(1), "pliCount": p }))
        })
        .collect();
    eprintln!("[layers] {per_layer:?}");

    // Tail: keep media flowing so a slightly-offset subscriber never sees zero frames.
    if args.tail > 0 {
        eprintln!("[tail] pumping {}s past the measurement window", args.tail);
        tokio::time::sleep(Duration::from_secs(args.tail)).await;
    }

    // 8. Write publish.json (requestShapes: exact SFU bodies used; appId/sessionId redacted).
    let ice_ms = connected_ms.load(Ordering::SeqCst);
    let mut session_resp_redacted = session.clone();
    if let Some(o) = session_resp_redacted.as_object_mut() {
        if o.contains_key("sessionId") {
            o["sessionId"] = json!("{sessionId}");
        }
    }
    let gates = json!({
        "iceConnected_le_5000ms": ice_ms > 0 && ice_ms <= 5000,
        "framesEncoded_ge_1500": frames_encoded >= 1500,
        "pliCount_le_6": pli_count <= 6,
    });
    let pass = ice_ms > 0 && ice_ms <= 5000 && frames_encoded >= 1500 && pli_count <= 6;
    let out = json!({
        "step": "S1.2/publisher",
        "gate": "P1",
        "config": { "width": width, "height": height, "fps": fps, "durationS": args.duration, "audioHz": 440, "simulcast": args.simulcast },
        "iceConnectedMs": ice_ms,
        "framesEncoded": frames_encoded,
        "bytesSent": bytes_sent,
        "pliCount": pli_count,
        "layersNegotiated": layers_negotiated,
        "perLayer": per_layer,
        "requiresImmediateRenegotiation": requires_reneg,
        "gates": gates,
        "pass": pass,
        "requestShapes": {
            "sessionsNew": {
                "method": "POST",
                "url": format!("{BASE}/apps/{{appId}}/sessions/new"),
                "request": Value::Null,
                "response": session_resp_redacted,
            },
            "tracksNew": {
                "method": "POST",
                "url": format!("{BASE}/apps/{{appId}}/sessions/{{sessionId}}/tracks/new"),
                "request": tracks_req,
                "response": tracks_resp,
            }
        }
    });
    let out_path = &args.out;
    std::fs::create_dir_all(Path::new(out_path).parent().unwrap())?;
    std::fs::write(out_path, serde_json::to_string_pretty(&out)?)?;
    eprintln!("[out] wrote {out_path}");

    println!(
        "P1 {}: iceConnectedMs={ice_ms} framesEncoded={frames_encoded} bytesSent={bytes_sent} pliCount={pli_count} layers={layers_negotiated}",
        if pass { "PASS" } else { "FAIL" }
    );
    if !pass {
        std::process::exit(1);
    }
    Ok(())
}

fn parse_args() -> Args {
    let mut args = Args {
        width: 640,
        height: 360,
        fps: 30,
        duration: 60,
        tail: 12,
        simulcast: false,
        out: concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results/publish.json").to_string(),
    };
    let a: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < a.len() {
        match a[i].as_str() {
            "--simulcast" => i += 1, // handled below via flag set
            flag if i + 1 < a.len() => {
                let v = &a[i + 1];
                match flag {
                    "--width" => args.width = v.parse().unwrap_or(args.width),
                    "--height" => args.height = v.parse().unwrap_or(args.height),
                    "--fps" => args.fps = v.parse().unwrap_or(args.fps),
                    "--duration" => args.duration = v.parse().unwrap_or(args.duration),
                    "--tail" => args.tail = v.parse().unwrap_or(args.tail),
                    "--out" => args.out = v.clone(),
                    _ => {}
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    args.simulcast = a.iter().any(|x| x == "--simulcast");
    args
}

fn spawn_video_pump(src: NativeVideoSource, w: u32, h: u32, fps: u64) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis((1000 / fps).max(1)));
        let mut phase = 0usize;
        loop {
            ticker.tick().await;
            // I420Buffer isn't Clone in 0.3.38; allocate + fully refill each tick.
            let mut buf = I420Buffer::new(w, h);
            fill_bars(&mut buf, w as usize, h as usize, phase);
            phase = (phase + 4) % (w as usize).max(1);
            let mut frame = VideoFrame::new(VideoRotation::VideoRotation0, buf);
            frame.timestamp_us =
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as i64;
            src.capture_frame(&frame); // sync, infallible
        }
    });
}

fn spawn_audio_pump(src: NativeAudioSource) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(10));
        let step = 2.0 * PI * 440.0 / AUDIO_HZ as f32;
        let mut ph = 0.0f32;
        loop {
            ticker.tick().await;
            let mut data = vec![0i16; SAMPLES_10MS * AUDIO_CH as usize];
            for s in data.iter_mut() {
                *s = (ph.sin() * 0.2 * i16::MAX as f32) as i16;
                ph += step;
                if ph > 2.0 * PI {
                    ph -= 2.0 * PI;
                }
            }
            let frame = AudioFrame {
                data: data.into(),
                sample_rate: AUDIO_HZ,
                num_channels: AUDIO_CH,
                samples_per_channel: SAMPLES_10MS as u32,
            };
            let _ = src.capture_frame(&frame).await; // async, Result
        }
    });
}

/// Scrolling SMPTE-style color bars in I420 (motion so the encoder keeps producing frames).
fn fill_bars(buf: &mut I420Buffer, w: usize, h: usize, phase: usize) {
    const fn rgb2i(r: i32, g: i32, b: i32) -> (u8, u8, u8) {
        const fn cl(v: i32) -> u8 {
            if v < 0 {
                0
            } else if v > 255 {
                255
            } else {
                v as u8
            }
        }
        (
            cl(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16),
            cl(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128),
            cl(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128),
        )
    }
    const BARS: [(u8, u8, u8); 7] = [
        rgb2i(191, 191, 191),
        rgb2i(191, 191, 0),
        rgb2i(0, 191, 191),
        rgb2i(0, 191, 0),
        rgb2i(191, 0, 191),
        rgb2i(191, 0, 0),
        rgb2i(0, 0, 191),
    ];
    let (sy, su, sv) = buf.strides();
    let (sy, su, sv) = (sy as usize, su as usize, sv as usize);
    let (y, u, v) = buf.data_mut();
    let n = BARS.len();
    for row in 0..h {
        for col in 0..w {
            let bar = BARS[(((col + phase) % w) * n / w).min(n - 1)].0;
            // High-frequency scrolling detail so encode cost scales with pixel count —
            // flat bars compress equally at any resolution, collapsing the simulcast
            // high/low bitrate ratio. This makes 720p genuinely cost ~4x 360p.
            let detail =
                (col.wrapping_mul(31).wrapping_add(row.wrapping_mul(17)).wrapping_add(phase)
                    as u8)
                    & 0x3F;
            y[row * sy + col] = bar.wrapping_add(detail);
        }
    }
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    for row in 0..ch {
        for col in 0..cw {
            let bar = (((col * 2 + phase) % w) * n / w).min(n - 1);
            u[row * su + col] = BARS[bar].1;
            v[row * sv + col] = BARS[bar].2;
        }
    }
}
