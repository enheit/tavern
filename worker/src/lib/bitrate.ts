// Bitrate (kbps) the SFU forwards for a pulled track + layer — the §1 simulcast
// /bitrate table, used for budget accrual. The Rust engine mirrors this table
// for publish encoding params (S5.2); this TS copy is the accrual source.

export type TrackShape = {
  kind: string; // 'mic' | 'screen' | 'webcam'
  width: number;
  height: number;
  fps: number;
  simulcast: boolean;
};

export function pulledBitrateKbps(track: TrackShape, layer: 'l' | 'h'): number {
  if (track.kind === 'mic') return 50; // Opus nominal
  const low = track.simulcast && layer === 'l';
  if (track.kind === 'screen') return low ? 300 : screenHigh(track.height, track.fps);
  // webcam
  return low ? 150 : webcamHigh(track.height);
}

// Screen h: base by captured height (native bucketing), fps multiplier, round to 50.
function screenHigh(height: number, fps: number): number {
  const base =
    height >= 1350 ? 4000 : height >= 900 ? 2500 : height >= 600 ? 1500 : height >= 400 ? 800 : 500;
  const mult = fps >= 120 ? 2.0 : fps >= 60 ? 1.5 : fps >= 30 ? 1.0 : 0.75;
  return Math.round((base * mult) / 50) * 50;
}

// Webcam h: fps-independent.
function webcamHigh(height: number): number {
  return height >= 600 ? 900 : height >= 400 ? 600 : 400; // 720 / 480 / 360
}
