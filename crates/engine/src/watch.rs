//! Video watch leg (S5.4): one str0m session per watched stream answers the SFU's pull
//! offer and emits DEPACKETIZED encoded VP8 frames — the S1.4 FALLBACK(a) branch (the
//! libwebrtc binding exposes no receive-side encoded-frame tap). Runs on its own blocking
//! thread (UDP + str0m poll loop, cribbed from the S1.4 tap spike).
//!
//! §1 chunk payload (little-endian): `{u32 len | u8 keyframe | u64 ptsMs | bytes}`. Frames
//! are dropped until the first keyframe (the first delivered chunk is guaranteed keyframe).
//! `droppedChunks` increments when the sink errors or the per-stream outbound queue exceeds
//! [`QUEUE_CAP`] frames.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use str0m::change::SdpOffer;
use str0m::media::{KeyframeRequestKind, MediaKind};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

use crate::state::EngineError;

/// §1: per-stream outbound queue cap; frames beyond it are discarded (and counted).
pub const QUEUE_CAP: usize = 60;

/// Sink receiving §1-framed chunk payloads; returns false when delivery failed
/// (counted as a dropped chunk). The Tauri layer wraps `Channel::send`.
pub type ChunkSink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;

/// §1 chunk framing: `{u32 len | u8 keyframe | u64 ptsMs | bytes}`, little-endian.
pub fn encode_chunk(keyframe: bool, pts_ms: u64, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 1 + 8 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.push(keyframe as u8);
    out.extend_from_slice(&pts_ms.to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// A live watch. Dropping it stops both threads.
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
    media_bytes: Arc<AtomicU64>,
    rtc_thread: Option<std::thread::JoinHandle<()>>,
    sink_thread: Option<std::thread::JoinHandle<()>>,
}

impl WatchHandle {
    pub fn dropped_chunks(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// UDP bytes received on this watch's socket (incl. STUN/RTCP/DTLS overhead).
    pub fn bytes_received(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    /// Depacketized MEDIA payload bytes for the track — the inbound-rtp egress-stop
    /// measure (§1 P5 proof: this freezes when the SFU stops forwarding).
    pub fn media_bytes(&self) -> u64 {
        self.media_bytes.load(Ordering::Relaxed)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for t in [self.rtc_thread.take(), self.sink_thread.take()]
            .into_iter()
            .flatten()
        {
            let _ = t.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Accept the SFU's pull offer and return (the answer SDP to send back, the running watch).
/// The str0m loop starts immediately — the SFU begins forwarding once it gets our answer
/// and our ICE checks land (peer-reflexive, S1.3/S1.4 pattern).
pub fn start_watch(
    offer_sdp: &str,
    mut sink: ChunkSink,
) -> Result<(String, WatchHandle), EngineError> {
    let mut rtc = str0m::RtcConfig::new()
        .clear_codecs()
        .enable_vp8(true)
        .build(Instant::now());
    let socket = UdpSocket::bind(SocketAddr::new(local_ipv4()?, 0))
        .map_err(|e| EngineError::Media(format!("watch socket: {e}")))?;
    let local_addr = socket
        .local_addr()
        .map_err(|e| EngineError::Media(format!("watch addr: {e}")))?;
    rtc.add_local_candidate(
        Candidate::host(local_addr, "udp")
            .map_err(|e| EngineError::Media(format!("candidate: {e}")))?,
    );
    let answer = rtc
        .sdp_api()
        .accept_offer(
            SdpOffer::from_sdp_string(offer_sdp)
                .map_err(|e| EngineError::Media(format!("watch offer parse: {e}")))?,
        )
        .map_err(|e| EngineError::Media(format!("watch accept_offer: {e}")))?;

    let stop = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let media_bytes = Arc::new(AtomicU64::new(0));

    // §1 queue: RTP loop → bounded channel → sink thread. try_send on a full queue drops
    // the frame (counted); sink errors count too. Keeps slow IPC out of the RTP loop.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_CAP);
    let sink_thread = std::thread::spawn({
        let dropped = dropped.clone();
        move || {
            while let Ok(chunk) = rx.recv() {
                if !sink(chunk) {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    });

    let rtc_thread = std::thread::spawn({
        let stop = stop.clone();
        let dropped = dropped.clone();
        let bytes = bytes.clone();
        let media_bytes = media_bytes.clone();
        move || run_rtc_loop(rtc, socket, tx, stop, dropped, bytes, media_bytes)
    });

    Ok((
        answer.to_sdp_string(),
        WatchHandle {
            stop,
            dropped,
            bytes,
            media_bytes,
            rtc_thread: Some(rtc_thread),
            sink_thread: Some(sink_thread),
        },
    ))
}

fn run_rtc_loop(
    mut rtc: Rtc,
    socket: UdpSocket,
    tx: mpsc::SyncSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
    media_bytes: Arc<AtomicU64>,
) {
    let mut video_mid = None;
    let mut seen_keyframe = false;
    let start = Instant::now();
    let mut last_pli = start;
    let mut buf = vec![0u8; 2000];

    while !stop.load(Ordering::Relaxed) {
        // PLI until the first keyframe so the stream opens decodable (§1: first delivered
        // chunk is guaranteed keyframe); S1.4 pattern.
        if !seen_keyframe {
            if let Some(mid) = video_mid {
                if last_pli.elapsed() >= Duration::from_millis(500) {
                    if let Some(rx) = rtc.direct_api().stream_rx_by_mid(mid, None) {
                        rx.request_keyframe(KeyframeRequestKind::Pli);
                    }
                    last_pli = Instant::now();
                }
            }
        }

        let timeout = match rtc.poll_output() {
            Err(_) => break,
            Ok(Output::Transmit(t)) => {
                let _ = socket.send_to(&t.contents, t.destination);
                continue;
            }
            Ok(Output::Event(e)) => {
                match e {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => break,
                    Event::MediaAdded(m) if m.kind == MediaKind::Video => video_mid = Some(m.mid),
                    Event::MediaData(d) if video_mid.is_none() || Some(d.mid) == video_mid => {
                        media_bytes.fetch_add(d.data.len() as u64, Ordering::Relaxed);
                        if d.is_keyframe() {
                            seen_keyframe = true;
                        }
                        if seen_keyframe {
                            let pts_ms = start.elapsed().as_millis() as u64;
                            let chunk = encode_chunk(d.is_keyframe(), pts_ms, &d.data);
                            if tx.try_send(chunk).is_err() {
                                // Queue full (> QUEUE_CAP) or sink thread gone: drop + count.
                                dropped.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    _ => {}
                }
                continue;
            }
            Ok(Output::Timeout(v)) => v,
        };

        let now = Instant::now();
        let wait = timeout
            .saturating_duration_since(now)
            .min(Duration::from_millis(200));
        if wait.is_zero() {
            if rtc.handle_input(Input::Timeout(now)).is_err() {
                break;
            }
            continue;
        }
        let _ = socket.set_read_timeout(Some(wait));
        buf.resize(2000, 0);
        match socket.recv_from(&mut buf) {
            Ok((n, source)) => {
                bytes.fetch_add(n as u64, Ordering::Relaxed);
                buf.truncate(n);
                let Ok(contents) = buf.as_slice().try_into() else {
                    continue;
                };
                let recv = Receive {
                    proto: Protocol::Udp,
                    source,
                    destination: local_dest(&socket),
                    contents,
                };
                if rtc
                    .handle_input(Input::Receive(Instant::now(), recv))
                    .is_err()
                {
                    break;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    // tx drops here → the sink thread's recv() errors and it exits.
}

fn local_dest(socket: &UdpSocket) -> SocketAddr {
    socket
        .local_addr()
        .unwrap_or_else(|_| SocketAddr::new(IpAddr::from([0, 0, 0, 0]), 0))
}

/// LAN IPv4 via connect() interface selection (no packet sent). The host candidate need not
/// be SFU-reachable — the ICE-lite SFU only answers our outbound checks (S1.4).
fn local_ipv4() -> Result<IpAddr, EngineError> {
    let s = UdpSocket::bind("0.0.0.0:0").map_err(|e| EngineError::Media(format!("bind: {e}")))?;
    s.connect("1.1.1.1:80")
        .map_err(|e| EngineError::Media(format!("connect: {e}")))?;
    Ok(s.local_addr()
        .map_err(|e| EngineError::Media(format!("addr: {e}")))?
        .ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §1 chunk layout: {u32 len | u8 keyframe | u64 ptsMs | bytes}, little-endian.
    #[test]
    fn chunk_framing_layout() {
        let c = encode_chunk(true, 0x0102030405060708, &[0xAA, 0xBB, 0xCC]);
        assert_eq!(&c[0..4], &3u32.to_le_bytes());
        assert_eq!(c[4], 1);
        assert_eq!(&c[5..13], &0x0102030405060708u64.to_le_bytes());
        assert_eq!(&c[13..], &[0xAA, 0xBB, 0xCC]);
        assert_eq!(c.len(), 4 + 1 + 8 + 3);

        let c = encode_chunk(false, 0, &[]);
        assert_eq!(&c[0..4], &0u32.to_le_bytes());
        assert_eq!(c[4], 0);
        assert_eq!(c.len(), 13);
    }

    /// Sink failures count as dropped chunks; successful sends don't.
    #[test]
    fn sink_errors_count_as_dropped() {
        let sent = Arc::new(AtomicU64::new(0));
        let sink: ChunkSink = {
            let sent = sent.clone();
            Box::new(move |_| {
                let n = sent.fetch_add(1, Ordering::Relaxed);
                n.is_multiple_of(2) // every other send "fails"
            })
        };
        // Drive the sink thread machinery directly (no RTC): emulate start_watch's wiring.
        let dropped = Arc::new(AtomicU64::new(0));
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_CAP);
        let t = std::thread::spawn({
            let dropped = dropped.clone();
            let mut sink = sink;
            move || {
                while let Ok(chunk) = rx.recv() {
                    if !sink(chunk) {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        });
        for i in 0..10u8 {
            tx.send(encode_chunk(false, i as u64, &[i])).unwrap();
        }
        drop(tx);
        t.join().unwrap();
        assert_eq!(sent.load(Ordering::Relaxed), 10);
        assert_eq!(dropped.load(Ordering::Relaxed), 5);
    }
}
