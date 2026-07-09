// §1 simulcast/bitrate tables — a line-for-line port of crates/capture/src/config.rs
// (plan_screen / plan_webcam) plus the browser flavor of crates/engine/src/video.rs
// encodings_for, so web publishes use the exact layers the desktop engine uses.
// plan.test.ts mirrors the Rust table tests to keep the two in lockstep.

export interface Layer {
  width: number;
  height: number;
  fps: number;
  maxKbps: number;
}

export interface EncodingPlan {
  h: Layer;
  l: Layer | null;
}

export function simulcast(plan: EncodingPlan): boolean {
  return plan.l !== null;
}

function fpsMult(fps: number): number {
  return fps === 15 ? 0.75 : fps === 60 ? 1.5 : fps === 120 ? 2.0 : 1.0;
}

/** Round to the nearest 50 kbps; .5 ties away from zero (matches f64::round). */
function round50(kbps: number): number {
  return Math.sign(kbps) * Math.round(Math.abs(kbps) / 50) * 50;
}

function even(x: number): number {
  return x & ~1;
}

function widthForHeight(srcW: number, srcH: number, targetH: number): number {
  return even(Math.round((srcW * targetH) / srcH));
}

/** §1 screen table. `selHeight` 0 = native; a selection ≥ source height degrades to native. */
export function planScreen(selHeight: number, fps: number, srcW: number, srcH: number): EncodingPlan {
  const native = selHeight === 0 || selHeight >= srcH;
  const [w, h] = native ? [even(srcW), even(srcH)] : [widthForHeight(srcW, srcH, selHeight), selHeight];
  const row = native ? (srcH >= 1350 ? 1440 : srcH >= 900 ? 1080 : srcH >= 600 ? 720 : 480) : selHeight;
  const [baseKbps, sim, floorMult] =
    row === 1440
      ? [4000, true, false]
      : row === 1080
        ? [2500, true, false]
        : row === 720
          ? [1500, true, false]
          : row === 480
            ? [800, false, true]
            : [500, false, false]; // 360
  const mult = floorMult ? Math.max(fpsMult(fps), 1.0) : fpsMult(fps);
  return {
    h: { width: w, height: h, fps, maxKbps: round50(baseKbps * mult) },
    l: sim ? { width: widthForHeight(w, h, 360), height: 360, fps: 15, maxKbps: 300 } : null,
  };
}

/** §1 webcam table (bitrates fps-independent). `cfgH` ∈ {360, 480, 720} per §0. */
export function planWebcam(cfgW: number, cfgH: number, fps: number): EncodingPlan {
  const [w, h] = [even(cfgW), even(cfgH)];
  const [kbps, sim] = cfgH === 720 ? [900, true] : cfgH === 480 ? [600, false] : [400, false];
  return {
    h: { width: w, height: h, fps, maxKbps: kbps },
    l: sim ? { width: widthForHeight(w, h, 180), height: 180, fps: 15, maxKbps: 150 } : null,
  };
}

/** Plan → RTCRtpEncodingParameters, the S1.3-proven simulcast shape: rid "h" scale 1.0 + rid "l". */
export function encodingsFor(plan: EncodingPlan): RTCRtpEncodingParameters[] {
  const h: RTCRtpEncodingParameters = {
    ...(plan.l ? { rid: 'h' } : {}),
    scaleResolutionDownBy: 1.0,
    maxBitrate: plan.h.maxKbps * 1000,
    maxFramerate: plan.h.fps,
  };
  if (!plan.l) return [h];
  return [
    h,
    {
      rid: 'l',
      scaleResolutionDownBy: plan.h.height / plan.l.height,
      maxBitrate: plan.l.maxKbps * 1000,
      maxFramerate: plan.l.fps,
    },
  ];
}
