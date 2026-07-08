//! Tavern media engine (S4.1 voice core): native libwebrtc + APM + cpal capture/playout,
//! signaling against the Worker's `/api/rtc/*`. The webview is pure UI; all media lives here.
//!
//! Layering: the pure, unit-tested cores — [`mixer`], [`pipeline`], [`state`], [`remote`],
//! [`signaling`] — carry the decision logic; [`engine::Engine`] + [`audio`] are the live
//! orchestration/device glue, first exercised end-to-end at S4.3 (P6).

pub mod apm;
pub mod audio;
pub mod engine;
pub mod mixer;
pub mod pipeline;
pub mod remote;
pub mod signaling;
pub mod state;
pub mod video;
pub mod watch;

pub use engine::{Engine, EngineStatus};
pub use state::{EngineError, VoiceState};
