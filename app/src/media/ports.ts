// The ONLY module in app/ allowed to touch the RTCPeerConnection / AudioContext / audio-element
// constructors (DoD grep gate, PLAN §7.2). Every other media module receives these ports injected,
// so the whole engine is unit-testable with fakes — no real WebRTC/WebAudio, no browser globals.

export interface RtcPort {
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;
}

export interface AudioPort {
  createContext(opts: { sampleRate: 48000 }): AudioContext;
  createAudioElement(): HTMLAudioElement; // muted flow-starter elements (crbug 40094084)
}

export const browserRtcPort: RtcPort = {
  createPeerConnection: (config) => new RTCPeerConnection(config),
};

export const browserAudioPort: AudioPort = {
  createContext: (opts) => new AudioContext(opts),
  createAudioElement: () => new Audio(),
};
