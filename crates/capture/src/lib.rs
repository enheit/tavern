//! Tavern screen/webcam capture (per-OS impls → I420 frames).
//!
//! Placeholder for Milestone 0; the real capture crate lands in Milestone 5.

/// Stable identifier for the capture crate.
pub fn capture_name() -> &'static str {
    "tavern-capture"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_stable() {
        assert_eq!(capture_name(), "tavern-capture");
    }
}
