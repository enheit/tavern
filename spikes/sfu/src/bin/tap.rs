//! S1.4 — Encoded-frame tap SPIKE — FALLBACK (a): str0m subscriber leg. Throwaway.
//!
//! The plan's PRIMARY path (extract encoded frames via the libwebrtc receive-side
//! frame-transformer / frame-cryptor hook) is NOT viable with the pinned engine: the
//! libwebrtc 0.3.38 binding runs both `FrameTransformerInterface` impls (FrameCryptor and
//! PacketTrailerTransformer) entirely in C++ and hands Rust only *metadata* — an
//! EncryptionState callback / timestamp observers — never the encoded bytes. Extracting them
//! would mean forking the native crate. So this takes the plan's pre-authorized FALLBACK (a):
//! a str0m subscriber that answers the SFU offer and emits DEPACKETIZED encoded VP8 frames,
//! written to an IVF file. See progress.md S1.4.
//!
//!   run (from spikes/sfu, CF_APP_ID / CF_APP_SECRET in env, AFTER publish started):
//!     cargo run --release --bin tap -- --width 640 --height 360 --frames 300 \
//!         --out ../../docs/spike-results/dump_360p.ivf
//!
//! Reads the publisher's {sessionId, videoTrackName} from target/handoff.json.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use str0m::change::SdpOffer;
use str0m::media::{KeyframeRequestKind, MediaKind};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

const BASE: &str = "https://rtc.live.cloudflare.com/v1";

struct Args {
    width: u16,
    height: u16,
    fps: u32,
    frames: usize, // target encoded frames to write
    timeout_s: u64,
    out: String,
    handoff: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    // Process-wide crypto provider (rust-crypto backend — pure Rust, no C build deps).
    str0m::crypto::from_feature_flags().install_process_default();

    let app_id = std::env::var("CF_APP_ID").map_err(|_| "CF_APP_ID not set")?;
    let secret = std::env::var("CF_APP_SECRET").map_err(|_| "CF_APP_SECRET not set")?;

    let (pub_session, video_track_name) = read_handoff(&args.handoff)?;
    eprintln!(
        "[cfg] tap {}x{}@{} → {} frames, publisher track={} → SFU app {}…",
        args.width,
        args.height,
        args.fps,
        args.frames,
        video_track_name,
        &app_id[..6]
    );

    let http = reqwest::blocking::Client::new();

    // 1. Our own (subscriber) session.
    let s_url = format!("{BASE}/apps/{app_id}/sessions/new");
    let resp = http.post(&s_url).bearer_auth(&secret).send()?;
    let (status, text) = (resp.status(), resp.text()?);
    if !status.is_success() {
        return Err(format!("sessions/new HTTP {status}: {text}").into());
    }
    let local_session = serde_json::from_str::<Value>(&text)?["sessionId"]
        .as_str()
        .ok_or("no sessionId")?
        .to_string();
    eprintln!("[sfu] local session created");

    // 2. Pull the remote VIDEO track (location:remote) — SFU generates the offer.
    let pull_req = json!({ "tracks": [{
        "location": "remote",
        "sessionId": pub_session,
        "trackName": video_track_name,
    }]});
    let t_url = format!("{BASE}/apps/{app_id}/sessions/{local_session}/tracks/new");
    let resp = http.post(&t_url).bearer_auth(&secret).json(&pull_req).send()?;
    let (status, text) = (resp.status(), resp.text()?);
    if !status.is_success() {
        return Err(format!("tracks/new(remote) HTTP {status}: {text}").into());
    }
    let pull_resp: Value = serde_json::from_str(&text)?;
    let offer_sdp = pull_resp["sessionDescription"]["sdp"]
        .as_str()
        .ok_or("no offer sdp")?
        .to_string();
    eprintln!(
        "[sfu] pulled, requiresImmediateRenegotiation={:?}",
        pull_resp.get("requiresImmediateRenegotiation")
    );

    // 3. str0m answerer — VP8-only for a deterministic tap. The SFU is ICE-lite/passive and
    //    provides a host candidate in its offer; our outbound checks drive connectivity (the
    //    same peer-reflexive pattern the libwebrtc subscriber used in S1.3).
    let mut rtc = RtcConfig::new()
        .clear_codecs()
        .enable_vp8(true)
        .build(Instant::now());
    let socket = UdpSocket::bind(SocketAddr::new(discover_local_ipv4()?, 0))?;
    let local_addr = socket.local_addr()?;
    rtc.add_local_candidate(Candidate::host(local_addr, "udp")?);
    let answer = rtc
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&offer_sdp)?)?;

    // 4. PUT our answer.
    let reneg_req =
        json!({ "sessionDescription": { "sdp": answer.to_sdp_string(), "type": "answer" } });
    let r_url = format!("{BASE}/apps/{app_id}/sessions/{local_session}/renegotiate");
    let resp = http.put(&r_url).bearer_auth(&secret).json(&reneg_req).send()?;
    let (status, text) = (resp.status(), resp.text()?);
    if !status.is_success() {
        return Err(format!("renegotiate HTTP {status}: {text}").into());
    }
    eprintln!("[sfu] renegotiated — driving str0m…");

    // 5. Drive I/O, collect depacketized VP8 frames, write IVF.
    let result = run_and_dump(&mut rtc, &socket, &args)?;

    // 6. Sidecar JSON. ffprobe does the codec/frame-count DoD check on the .ivf itself.
    let out_json = format!("{}.json", args.out.trim_end_matches(".ivf"));
    let sidecar = json!({
        "step": "S1.4/encoded-frame-tap",
        "branch": "FALLBACK(a): str0m subscriber leg — primary libwebrtc frame-transformer/cryptor hook not exposed by the 0.3.38 binding",
        "str0m": "0.21.0 (rust-crypto backend)",
        "container": "IVF",
        "codec": result.codec,
        "resolution": format!("{}x{}", args.width, args.height),
        "framesWritten": result.frames_written,
        "keyframes": result.keyframes,
        "iceConnectedMs": result.ice_ms,
        "out": Path::new(&args.out).file_name().unwrap().to_string_lossy(),
    });
    std::fs::write(&out_json, serde_json::to_string_pretty(&sidecar)?)?;

    println!(
        "TAP {}x{}: codec={} framesWritten={} keyframes={} iceMs={} → {}",
        args.width, args.height, result.codec, result.frames_written, result.keyframes, result.ice_ms, args.out
    );
    if result.frames_written < args.frames {
        return Err(format!("only wrote {} frames (< {})", result.frames_written, args.frames).into());
    }
    Ok(())
}

struct TapResult {
    codec: String,
    frames_written: usize,
    keyframes: usize,
    ice_ms: u64,
}

fn run_and_dump(
    rtc: &mut Rtc,
    socket: &UdpSocket,
    args: &Args,
) -> Result<TapResult, Box<dyn std::error::Error>> {
    let mut ivf = IvfWriter::create(&args.out, args.width, args.height, args.fps)?;
    let mut video_mid = None;
    let mut seen_keyframe = false;
    let mut keyframes = 0usize;
    let mut codec = String::from("?");
    let mut ice_ms = 0u64;

    let start = Instant::now();
    let deadline = start + Duration::from_secs(args.timeout_s);
    let mut last_pli = start;
    let mut buf = vec![0u8; 2000];

    loop {
        if ivf.count >= args.frames || Instant::now() >= deadline {
            break;
        }

        // Periodic PLI until the first keyframe — kick the SFU/publisher for an IDR so the
        // IVF starts on a decodable frame.
        if !seen_keyframe {
            if let Some(mid) = video_mid {
                if Instant::now().duration_since(last_pli) >= Duration::from_millis(500) {
                    if let Some(rx) = rtc.direct_api().stream_rx_by_mid(mid, None) {
                        rx.request_keyframe(KeyframeRequestKind::Pli);
                    }
                    last_pli = Instant::now();
                }
            }
        }

        let timeout = match rtc.poll_output()? {
            Output::Timeout(v) => v,
            Output::Transmit(t) => {
                socket.send_to(&t.contents, t.destination)?;
                continue;
            }
            Output::Event(e) => {
                match e {
                    Event::Connected => {
                        if ice_ms == 0 {
                            ice_ms = start.elapsed().as_millis() as u64;
                        }
                    }
                    Event::IceConnectionStateChange(st) => {
                        eprintln!("[ice] {st:?}");
                        if st == IceConnectionState::Disconnected {
                            break;
                        }
                    }
                    Event::MediaAdded(m) => {
                        if m.kind == MediaKind::Video {
                            video_mid = Some(m.mid);
                            eprintln!("[media] video mid={} dir={:?}", m.mid, m.direction);
                        }
                    }
                    Event::MediaData(d) => {
                        if video_mid.is_none() || Some(d.mid) == video_mid {
                            if d.is_keyframe() {
                                codec = format!("{:?}", d.params.spec().codec);
                                seen_keyframe = true;
                                keyframes += 1;
                            }
                            // Only start writing at the first keyframe → valid IVF.
                            if seen_keyframe {
                                ivf.write_frame(&d.data)?;
                                if ivf.count % 30 == 0 {
                                    eprintln!("[tap] {} frames ({} kf)", ivf.count, keyframes);
                                }
                            }
                        }
                    }
                    _ => {}
                }
                continue;
            }
        };

        // Cap the wait so PLI/deadline logic stays responsive.
        let now = Instant::now();
        let wait = timeout
            .saturating_duration_since(now)
            .min(Duration::from_millis(200));
        if wait.is_zero() {
            rtc.handle_input(Input::Timeout(now))?;
            continue;
        }
        socket.set_read_timeout(Some(wait))?;
        buf.resize(2000, 0);
        match socket.recv_from(&mut buf) {
            Ok((n, source)) => {
                buf.truncate(n);
                let recv = Receive {
                    proto: Protocol::Udp,
                    source,
                    destination: socket.local_addr()?,
                    contents: buf.as_slice().try_into()?,
                };
                rtc.handle_input(Input::Receive(Instant::now(), recv))?;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                rtc.handle_input(Input::Timeout(Instant::now()))?;
            }
            Err(e) => return Err(e.into()),
        }
    }

    ivf.finalize()?;
    if codec == "?" {
        codec = "Vp8".into(); // VP8-only negotiated; a keyframe would have set it explicitly
    }
    Ok(TapResult { codec, frames_written: ivf.count, keyframes, ice_ms })
}

/// Minimal IVF (RFC-less de-facto libvpx container) writer. 32-byte file header + per-frame
/// 12-byte header (size LE + timestamp LE). ffprobe -count_frames reads the actual frames.
struct IvfWriter {
    file: File,
    count: usize,
}

impl IvfWriter {
    fn create(path: &str, w: u16, h: u16, fps: u32) -> std::io::Result<Self> {
        if let Some(p) = Path::new(path).parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut file = File::create(path)?;
        let mut hdr = [0u8; 32];
        hdr[0..4].copy_from_slice(b"DKIF");
        // [4..6] version = 0
        hdr[6..8].copy_from_slice(&32u16.to_le_bytes()); // header length
        hdr[8..12].copy_from_slice(b"VP80");
        hdr[12..14].copy_from_slice(&w.to_le_bytes());
        hdr[14..16].copy_from_slice(&h.to_le_bytes());
        hdr[16..20].copy_from_slice(&fps.to_le_bytes()); // timebase denominator
        hdr[20..24].copy_from_slice(&1u32.to_le_bytes()); // timebase numerator
        // [24..28] frame count — patched in finalize()
        file.write_all(&hdr)?;
        Ok(Self { file, count: 0 })
    }

    fn write_frame(&mut self, data: &[u8]) -> std::io::Result<()> {
        let mut fh = [0u8; 12];
        fh[0..4].copy_from_slice(&(data.len() as u32).to_le_bytes());
        fh[4..12].copy_from_slice(&(self.count as u64).to_le_bytes());
        self.file.write_all(&fh)?;
        self.file.write_all(data)?;
        self.count += 1;
        Ok(())
    }

    fn finalize(&mut self) -> std::io::Result<()> {
        self.file.seek(SeekFrom::Start(24))?;
        self.file.write_all(&(self.count as u32).to_le_bytes())?;
        self.file.flush()
    }
}

/// Discover the machine's LAN IPv4 by opening a UDP socket toward a public address (no packet
/// is sent — connect() just picks the outbound interface). The host candidate need not be
/// SFU-reachable: the ICE-lite SFU only responds to our checks.
fn discover_local_ipv4() -> std::io::Result<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0")?;
    s.connect("1.1.1.1:80")?;
    Ok(s.local_addr()?.ip())
}

fn read_handoff(path: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
    for _ in 0..40 {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let (Some(sid), Some(tn)) =
                    (v["sessionId"].as_str(), v["videoTrackName"].as_str())
                {
                    return Ok((sid.to_string(), tn.to_string()));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("handoff not available (publisher not started?)".into())
}

fn parse_args() -> Args {
    let mut args = Args {
        width: 640,
        height: 360,
        fps: 30,
        frames: 300,
        timeout_s: 45,
        out: concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results/dump_360p.ivf")
            .to_string(),
        handoff: concat!(env!("CARGO_MANIFEST_DIR"), "/target/handoff.json").to_string(),
    };
    let a: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < a.len() {
        match a[i].as_str() {
            "--width" => args.width = a[i + 1].parse().unwrap_or(args.width),
            "--height" => args.height = a[i + 1].parse().unwrap_or(args.height),
            "--fps" => args.fps = a[i + 1].parse().unwrap_or(args.fps),
            "--frames" => args.frames = a[i + 1].parse().unwrap_or(args.frames),
            "--timeout" => args.timeout_s = a[i + 1].parse().unwrap_or(args.timeout_s),
            "--out" => args.out = a[i + 1].clone(),
            "--handoff" => args.handoff = a[i + 1].clone(),
            _ => {}
        }
        i += 1;
    }
    args
}
