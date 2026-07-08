//! Tavern media engine (libwebrtc + APM + capture/playout).
//!
//! Placeholder for Milestone 0; the real engine lands in Milestone 4+.

/// Stable identifier for the engine crate.
pub fn engine_name() -> &'static str {
    "tavern-engine"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_stable() {
        assert_eq!(engine_name(), "tavern-engine");
    }
}
