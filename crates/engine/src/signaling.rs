//! SFU signaling against the Worker's `/api/rtc/*` (PLAN §1 Media-signaling). The engine never
//! talks to the SFU directly or over the WebSocket: it POSTs to the Worker (bearer = the user's
//! session token), which authorizes, proxies the SFU with its secret, and returns the SFU reply
//! verbatim under `sfu`. Roles: publishing → the client is the SDP **offerer**; subscribing →
//! the SFU offers and the client **answers** via `renegotiate`.
//!
//! This layer is a thin HTTP wrapper over `reqwest`, so its DoD test drives it with a mock HTTP
//! server and synthetic SDP — no libwebrtc, no audio device.

use serde_json::{json, Value};

/// Track descriptor for a publish (top-level fields the DO records in its registry).
pub struct PublishTrack {
    pub track_name: String,
    /// "mic" | "screen" | "webcam"
    pub kind: String,
    /// Transceiver mid from the local PeerConnection after set_local_description.
    pub mid: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub simulcast: bool,
}

/// The SFU's answer to a publish: its answer SDP and whether it wants an immediate renegotiate.
#[derive(Debug, Clone)]
pub struct Answer {
    pub sdp: String,
    pub requires_reneg: bool,
}

/// The SFU's offer when pulling a track (roles reversed — the client answers this).
#[derive(Debug, Clone)]
pub struct Offer {
    pub sdp: String,
    pub requires_reneg: bool,
}

/// Signaling failures.
#[derive(Debug)]
pub enum SignalError {
    /// Network / connection error reaching the Worker.
    Transport(String),
    /// Non-2xx from the Worker; `code` is the JSON `{code}` body when present
    /// (e.g. `not_in_voice`, `share_limit`, `budget_exceeded`, `rate_limited`).
    Http { status: u16, code: Option<String> },
    /// 2xx but the body was missing an expected field.
    Malformed(String),
}

impl std::fmt::Display for SignalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SignalError::Transport(e) => write!(f, "signaling transport: {e}"),
            SignalError::Http { status, code } => {
                write!(
                    f,
                    "signaling http {status} ({})",
                    code.as_deref().unwrap_or("-")
                )
            }
            SignalError::Malformed(e) => write!(f, "signaling malformed: {e}"),
        }
    }
}
impl std::error::Error for SignalError {}

/// Signaling client. Cheap to clone (shares one connection pool). `api_base`/`token` come from
/// `engine_configure`; the WS URL is derived elsewhere — this only speaks HTTP.
#[derive(Clone)]
pub struct Signaling {
    http: reqwest::Client,
    api_base: String,
    token: String,
}

impl Signaling {
    pub fn new(api_base: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_base: api_base.into(),
            token: token.into(),
        }
    }

    /// Test/DI seam: inject a preconfigured client.
    pub fn with_client(
        http: reqwest::Client,
        api_base: impl Into<String>,
        token: impl Into<String>,
    ) -> Self {
        Self {
            http,
            api_base: api_base.into(),
            token: token.into(),
        }
    }

    async fn post(&self, op: &str, body: Value) -> Result<Value, SignalError> {
        let url = format!("{}/api/rtc/{op}", self.api_base.trim_end_matches('/'));
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| SignalError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| SignalError::Transport(e.to_string()))?;
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let code = value
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string);
            return Err(SignalError::Http { status, code });
        }
        Ok(value)
    }

    /// Establish the SFU session for this channel (DO records `userId → sfuSessionId`).
    pub async fn session(&self, channel_id: &str) -> Result<(), SignalError> {
        self.post("session", json!({ "channelId": channel_id }))
            .await
            .map(|_| ())
    }

    /// Publish a local track. Client is the offerer: we send our offer SDP + the track's mid.
    pub async fn publish(
        &self,
        channel_id: &str,
        track: &PublishTrack,
        offer_sdp: &str,
    ) -> Result<Answer, SignalError> {
        let body = json!({
            "channelId": channel_id,
            "trackName": track.track_name,
            "kind": track.kind,
            "width": track.width,
            "height": track.height,
            "fps": track.fps,
            "simulcast": track.simulcast,
            "sfu": {
                "sessionDescription": { "sdp": offer_sdp, "type": "offer" },
                "tracks": [{ "location": "local", "mid": track.mid, "trackName": track.track_name }],
            },
        });
        let v = self.post("publish", body).await?;
        answer_from(&v)
    }

    /// Subscribe to (pull) a remote track. No SDP is sent — the SFU replies with its offer.
    pub async fn subscribe(
        &self,
        channel_id: &str,
        owner_id: &str,
        track_name: &str,
        layer: &str,
    ) -> Result<Offer, SignalError> {
        let body = json!({
            "channelId": channel_id,
            "ownerId": owner_id,
            "trackName": track_name,
            "layer": layer,
        });
        let v = self.post("subscribe", body).await?;
        let sdp =
            sfu_sdp(&v).ok_or_else(|| SignalError::Malformed("subscribe: no offer sdp".into()))?;
        Ok(Offer {
            sdp,
            requires_reneg: sfu_requires_reneg(&v),
        })
    }

    /// Answer the SFU's pull offer (client-answers leg of the roles-reversed pull).
    pub async fn renegotiate(&self, channel_id: &str, answer_sdp: &str) -> Result<(), SignalError> {
        let body = json!({
            "channelId": channel_id,
            "sfu": { "sessionDescription": { "sdp": answer_sdp, "type": "answer" } },
        });
        self.post("renegotiate", body).await.map(|_| ())
    }

    /// Stop pulling a remote track (SFU tracks/close + DO stops accrual).
    pub async fn unsubscribe(
        &self,
        channel_id: &str,
        owner_id: &str,
        track_name: &str,
    ) -> Result<(), SignalError> {
        let body = json!({ "channelId": channel_id, "ownerId": owner_id, "trackName": track_name });
        self.post("unsubscribe", body).await.map(|_| ())
    }

    /// Stop publishing a local track (SFU tracks/close + DO deregisters + broadcasts).
    pub async fn unpublish(&self, channel_id: &str, track_name: &str) -> Result<(), SignalError> {
        let body = json!({ "channelId": channel_id, "trackName": track_name });
        self.post("unpublish", body).await.map(|_| ())
    }

    /// Close the SFU session (leave voice): clears the user's tracks + subscriptions server-side.
    pub async fn close(&self, channel_id: &str) -> Result<(), SignalError> {
        self.post("close", json!({ "channelId": channel_id }))
            .await
            .map(|_| ())
    }
}

fn sfu_sdp(v: &Value) -> Option<String> {
    v.get("sfu")?
        .get("sessionDescription")?
        .get("sdp")?
        .as_str()
        .map(str::to_string)
}

fn sfu_requires_reneg(v: &Value) -> bool {
    v.get("sfu")
        .and_then(|s| s.get("requiresImmediateRenegotiation"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn answer_from(v: &Value) -> Result<Answer, SignalError> {
    let sdp = sfu_sdp(v).ok_or_else(|| SignalError::Malformed("publish: no answer sdp".into()))?;
    Ok(Answer {
        sdp,
        requires_reneg: sfu_requires_reneg(v),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sig(base: &str) -> Signaling {
        Signaling::new(base, "tok-123")
    }

    /// DoD: publish path — client is the offerer; body carries the offer SDP + a local track,
    /// and the SFU answer (with requiresImmediateRenegotiation=false) is parsed.
    #[tokio::test]
    async fn publish_offerer_path() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/rtc/publish"))
            .and(header("authorization", "Bearer tok-123"))
            .and(body_json(json!({
                "channelId": "chan1",
                "trackName": "mic-abc",
                "kind": "mic",
                "width": 0, "height": 0, "fps": 0,
                "simulcast": false,
                "sfu": {
                    "sessionDescription": { "sdp": "OFFER_SDP", "type": "offer" },
                    "tracks": [{ "location": "local", "mid": "0", "trackName": "mic-abc" }],
                },
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sfu": {
                    "sessionDescription": { "sdp": "ANSWER_SDP", "type": "answer" },
                    "requiresImmediateRenegotiation": false,
                },
            })))
            .expect(1)
            .mount(&server)
            .await;

        let track = PublishTrack {
            track_name: "mic-abc".into(),
            kind: "mic".into(),
            mid: "0".into(),
            width: 0,
            height: 0,
            fps: 0,
            simulcast: false,
        };
        let ans = sig(&server.uri())
            .publish("chan1", &track, "OFFER_SDP")
            .await
            .unwrap();
        assert_eq!(ans.sdp, "ANSWER_SDP");
        assert!(!ans.requires_reneg);
    }

    /// DoD: pull path — client sends NO SDP, the SFU offers (requiresImmediateRenegotiation=true),
    /// and the client answers via renegotiate. Covers server-offers/client-answers + renegotiate.
    #[tokio::test]
    async fn subscribe_then_renegotiate_answerer_path() {
        let server = MockServer::start().await;
        // Pull: no sessionDescription in the request; SFU replies with an offer.
        Mock::given(method("POST"))
            .and(path("/api/rtc/subscribe"))
            .and(body_json(json!({
                "channelId": "chan1",
                "ownerId": "owner9",
                "trackName": "mic-xyz",
                "layer": "h",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sfu": {
                    "sessionDescription": { "sdp": "SFU_OFFER", "type": "offer" },
                    "requiresImmediateRenegotiation": true,
                },
            })))
            .expect(1)
            .mount(&server)
            .await;
        // Renegotiate: client answers with its answer SDP.
        Mock::given(method("POST"))
            .and(path("/api/rtc/renegotiate"))
            .and(body_json(json!({
                "channelId": "chan1",
                "sfu": { "sessionDescription": { "sdp": "MY_ANSWER", "type": "answer" } },
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "sfu": {} })))
            .expect(1)
            .mount(&server)
            .await;

        let s = sig(&server.uri());
        let offer = s
            .subscribe("chan1", "owner9", "mic-xyz", "h")
            .await
            .unwrap();
        assert_eq!(offer.sdp, "SFU_OFFER");
        assert!(offer.requires_reneg);
        s.renegotiate("chan1", "MY_ANSWER").await.unwrap();
    }

    /// A `{code}` error body (e.g. not_in_voice) surfaces as a typed Http error with the code.
    #[tokio::test]
    async fn error_code_is_surfaced() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/rtc/session"))
            .respond_with(
                ResponseTemplate::new(403).set_body_json(json!({ "code": "not_in_voice" })),
            )
            .mount(&server)
            .await;
        let err = sig(&server.uri()).session("chan1").await.unwrap_err();
        match err {
            SignalError::Http { status, code } => {
                assert_eq!(status, 403);
                assert_eq!(code.as_deref(), Some("not_in_voice"));
            }
            other => panic!("expected Http error, got {other:?}"),
        }
    }

    /// Teardown ops (unsubscribe/unpublish/close) POST their identifiers and accept an ok reply.
    #[tokio::test]
    async fn teardown_ops_post_expected_bodies() {
        let server = MockServer::start().await;
        for (p, body) in [
            (
                "/api/rtc/unsubscribe",
                json!({ "channelId": "c1", "ownerId": "o1", "trackName": "mic-x" }),
            ),
            (
                "/api/rtc/unpublish",
                json!({ "channelId": "c1", "trackName": "mic-me" }),
            ),
            ("/api/rtc/close", json!({ "channelId": "c1" })),
        ] {
            Mock::given(method("POST"))
                .and(path(p))
                .and(body_json(body))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "sfu": null })))
                .expect(1)
                .mount(&server)
                .await;
        }
        let s = sig(&server.uri());
        s.unsubscribe("c1", "o1", "mic-x").await.unwrap();
        s.unpublish("c1", "mic-me").await.unwrap();
        s.close("c1").await.unwrap();
    }

    #[test]
    fn signal_error_displays() {
        assert_eq!(
            SignalError::Http {
                status: 429,
                code: Some("rate_limited".into())
            }
            .to_string(),
            "signaling http 429 (rate_limited)"
        );
        assert!(SignalError::Transport("x".into())
            .to_string()
            .contains("transport"));
    }
}
