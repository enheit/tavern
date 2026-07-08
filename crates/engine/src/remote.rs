//! Remote-track diffing for mic auto-subscribe (PLAN §1). The UI forwards the full current track
//! roster via `set_remote_tracks`; the engine auto-subscribes every **mic** track (never video —
//! screen/webcam are joined explicitly via `stream_watch`) that isn't ours, and tears down
//! subscriptions for mic tracks that vanished from the roster. Pure and device-free.

use std::collections::BTreeSet;

use tavern_protocol::TrackInfo;

/// An owner+track identity for a subscription.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct TrackRef {
    pub owner_id: String,
    pub track_name: String,
}

/// The mic subscriptions to add and remove to reach the new roster.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MicDiff {
    pub subscribe: Vec<TrackRef>,
    pub unsubscribe: Vec<TrackRef>,
}

impl MicDiff {
    pub fn is_empty(&self) -> bool {
        self.subscribe.is_empty() && self.unsubscribe.is_empty()
    }
}

/// Diff `current` mic subscriptions against the new full `roster`. Only `kind == "mic"` tracks not
/// owned by `self_user_id` are wanted; everything else (our own mic, screen, webcam) is ignored.
pub fn diff_mic(current: &BTreeSet<TrackRef>, roster: &[TrackInfo], self_user_id: &str) -> MicDiff {
    let wanted: BTreeSet<TrackRef> = roster
        .iter()
        .filter(|t| t.kind == "mic" && t.owner_id != self_user_id)
        .map(|t| TrackRef {
            owner_id: t.owner_id.clone(),
            track_name: t.track_name.clone(),
        })
        .collect();
    MicDiff {
        subscribe: wanted.difference(current).cloned().collect(),
        unsubscribe: current.difference(&wanted).cloned().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(owner: &str, name: &str, kind: &str) -> TrackInfo {
        TrackInfo {
            owner_id: owner.into(),
            track_name: name.into(),
            kind: kind.into(),
            simulcast: false,
            width: 0,
            height: 0,
            fps: 0,
        }
    }
    fn tref(owner: &str, name: &str) -> TrackRef {
        TrackRef {
            owner_id: owner.into(),
            track_name: name.into(),
        }
    }

    #[test]
    fn new_mic_track_is_subscribed_video_and_self_ignored() {
        let current = BTreeSet::new();
        let roster = [
            track("bob", "mic-b", "mic"),
            track("bob", "screen-b", "screen"), // video: never auto-subscribed
            track("cara", "webcam-c", "webcam"), // video: ignored
            track("me", "mic-me", "mic"),       // our own mic: ignored
        ];
        let diff = diff_mic(&current, &roster, "me");
        assert_eq!(diff.subscribe, vec![tref("bob", "mic-b")]);
        assert!(diff.unsubscribe.is_empty());
    }

    #[test]
    fn vanished_mic_is_unsubscribed() {
        let mut current = BTreeSet::new();
        current.insert(tref("bob", "mic-b"));
        current.insert(tref("cara", "mic-c"));
        // Roster now only has bob's mic; cara left.
        let roster = [track("bob", "mic-b", "mic")];
        let diff = diff_mic(&current, &roster, "me");
        assert!(diff.subscribe.is_empty());
        assert_eq!(diff.unsubscribe, vec![tref("cara", "mic-c")]);
    }

    #[test]
    fn steady_state_is_noop() {
        let mut current = BTreeSet::new();
        current.insert(tref("bob", "mic-b"));
        let roster = [
            track("bob", "mic-b", "mic"),
            track("bob", "screen-b", "screen"),
        ];
        assert!(diff_mic(&current, &roster, "me").is_empty());
    }

    #[test]
    fn empty_roster_tears_down_all() {
        let mut current = BTreeSet::new();
        current.insert(tref("bob", "mic-b"));
        let diff = diff_mic(&current, &[], "me");
        assert_eq!(diff.unsubscribe, vec![tref("bob", "mic-b")]);
        assert!(diff.subscribe.is_empty());
    }
}
