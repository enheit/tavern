//! Tavern wire-protocol types.
//!
//! Placeholder for Milestone 0; the serde/ts-rs protocol types land in Milestone 2.

/// Protocol version carried in every WebSocket frame (`{"v":1,...}`).
pub const PROTOCOL_VERSION: u8 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_one() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }
}
