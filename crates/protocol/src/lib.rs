//! Tavern wire-protocol types — the single source of truth (PLAN §1 "Protocol
//! types"). Defined once here in Rust (serde) and exported to TypeScript via
//! ts-rs into `worker/src/protocol/` + `app/src/lib/protocol/` (see the
//! `gen:protocol` script + CI git-diff gate). The Rust engine consumes these
//! directly; the worker and app import the generated `.ts`.
//!
//! Frames travel as JSON `{ "v": 1, "t": "<type>", ... }`. The `t` discriminant
//! is modeled by the serde-tagged enums below; the `v` version is a transport
//! envelope constant added/ignored at the edges (kept out of the type model).
//!
//! ts-rs notes: `#[ts(rename_all = "camelCase")]` is set explicitly (ts-rs does
//! not always pick up serde's `rename_all` for fields), and 64-bit ints are
//! mapped to `number` because they arrive from `JSON.parse` as JS numbers, not
//! `bigint` (all our ids/timestamps are well under 2^53).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Protocol version carried in every WebSocket frame (`{"v":1,...}`).
pub const PROTOCOL_VERSION: u8 = 1;

// ---- shared data types ----------------------------------------------------

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub nickname: String,
    pub color: String,
    pub avatar_key: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Presence {
    pub user_id: String,
    /// "online" | "voice" | "offline"
    pub state: String,
    pub channel_id: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct TrackInfo {
    pub owner_id: String,
    pub track_name: String,
    /// "mic" | "screen" | "webcam"
    pub kind: String,
    pub simulcast: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ChatMsg {
    #[ts(type = "number")]
    pub id: i64,
    pub channel_id: String,
    pub user_id: String,
    pub content: String,
    pub nonce: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Budget {
    /// "ok" | "soft" | "hard"
    pub level: String,
    pub est_mbps: f64,
    pub month_gb: f64,
}

// ---- client → server frames ----------------------------------------------

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
#[ts(export, rename_all_fields = "camelCase")]
pub enum ClientFrame {
    #[serde(rename = "chat.send")]
    ChatSend {
        channel_id: String,
        content: String,
        nonce: String,
    },
    #[serde(rename = "chat.history")]
    ChatHistory {
        channel_id: String,
        #[ts(type = "number | null")]
        before_id: Option<i64>,
        limit: u32,
    },
    #[serde(rename = "voice.join")]
    VoiceJoin { channel_id: String },
    #[serde(rename = "voice.leave")]
    VoiceLeave {},
    #[serde(rename = "heartbeat")]
    Heartbeat {},
}

// ---- server → client frames ----------------------------------------------

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
#[ts(export, rename_all_fields = "camelCase")]
pub enum ServerFrame {
    #[serde(rename = "hello.ok")]
    HelloOk {
        user_id: String,
        roster: Vec<Member>,
        presence: Vec<Presence>,
        tracks: Vec<TrackInfo>,
        budget: Budget,
    },
    #[serde(rename = "heartbeat.ok")]
    HeartbeatOk {},
    #[serde(rename = "error")]
    Error { code: String, msg: String },
    #[serde(rename = "chat.msg")]
    ChatMsgFrame {
        #[ts(type = "number")]
        id: i64,
        channel_id: String,
        user_id: String,
        content: String,
        nonce: Option<String>,
        #[ts(type = "number")]
        created_at: i64,
    },
    #[serde(rename = "chat.history")]
    ChatHistoryFrame {
        channel_id: String,
        messages: Vec<ChatMsg>,
        has_more: bool,
    },
    #[serde(rename = "presence")]
    PresenceFrame {
        user_id: String,
        state: String,
        channel_id: Option<String>,
    },
    #[serde(rename = "profile")]
    ProfileFrame {
        user_id: String,
        nickname: String,
        color: String,
        avatar_key: Option<String>,
    },
    #[serde(rename = "tracks")]
    TracksFrame {
        owner_id: String,
        tracks: Vec<TrackInfo>,
    },
    #[serde(rename = "budget")]
    BudgetFrame {
        level: String,
        est_mbps: f64,
        month_gb: f64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_one() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }
}
