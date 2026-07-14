import {
  VOICE_AVATAR_LEGACY_HAIR_COLORS,
  VOICE_AVATAR_LEGACY_HAIR_STYLES,
  VOICE_AVATAR_LEGACY_SKIN_TONES,
} from "@tavern/shared";
import type {
  VoiceAvatarConfig,
  VoiceAvatarEyeColor,
  VoiceAvatarFacialHairStyle,
  VoiceAvatarGlassesStyle,
  VoiceAvatarHairColor,
  VoiceAvatarHairStyle,
  VoiceAvatarSkinTone,
} from "@tavern/shared";
import type {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
} from "three";

type ThreeModule = typeof import("three");

export function browserSupportsVoiceAvatarWebGL(): boolean {
  return (
    typeof WebGLRenderingContext !== "undefined" || typeof WebGL2RenderingContext !== "undefined"
  );
}

export interface VoiceAvatarMember {
  userId: string;
  color: string;
  muted: boolean;
  voiceAvatar?: VoiceAvatarConfig;
}

export interface VoiceAvatarStyle {
  skin: string;
  hair: string;
  eyes: string;
  hairStyle: VoiceAvatarHairStyle;
  glassesStyle: VoiceAvatarGlassesStyle;
  facialHairStyle: VoiceAvatarFacialHairStyle;
}

export interface VoiceAvatarStage {
  resize(width: number, height: number): void;
  render(
    timeMs: number,
    motionEnabled: boolean,
    readLevel: (userId: string, timeMs: number) => number,
  ): void;
  dispose(): void;
}

interface AvatarRig {
  userId: string;
  muted: boolean;
  seed: number;
  root: Group;
  head: Group;
  mouthInner: Mesh;
  teeth: Mesh;
  leftEye: Group;
  rightEye: Group;
  level: number;
}

export const VOICE_AVATAR_SKIN_HEX = {
  porcelain: "#f9e0ca",
  light: "#f6d0b1",
  "light-medium": "#e7ad82",
  "warm-medium": "#daa06f",
  medium: "#c98257",
  tan: "#b26f48",
  "medium-deep": "#9a5d3b",
  deep: "#70412f",
  rich: "#573127",
  ebony: "#3b231c",
} as const satisfies Record<VoiceAvatarSkinTone, string>;

export const VOICE_AVATAR_HAIR_HEX = {
  black: "#18181b",
  "dark-brown": "#35241c",
  brown: "#6b3f24",
  chestnut: "#8a4f2d",
  auburn: "#8b3f2b",
  ginger: "#c45a2c",
  "golden-brown": "#b7793b",
  blonde: "#d7b574",
  platinum: "#ead9ae",
  gray: "#8b8b8c",
  white: "#ddd8d0",
  violet: "#5b4a89",
} as const satisfies Record<VoiceAvatarHairColor, string>;

export const VOICE_AVATAR_EYE_HEX = {
  "dark-brown": "#2b1a12",
  brown: "#5a3825",
  hazel: "#8a6a38",
  amber: "#b57432",
  green: "#547b52",
  blue: "#4b78a8",
  gray: "#77808b",
} as const satisfies Record<VoiceAvatarEyeColor, string>;

const MOUTH_IDLE_SCALE_Y = 0.0816;
const MOUTH_OPEN_SCALE_Y = 0.5496;
const MOUTH_TOP_Y = MOUTH_IDLE_SCALE_Y / 2;
const TEETH_IDLE_Y = 0.012;
const TEETH_MOUTH_TRAVEL_RATIO = 0.18;

export function voiceAvatarMouthPose(level: number): {
  scaleY: number;
  centerY: number;
  teethY: number;
} {
  const clampedLevel = Math.max(0, Math.min(1, level));
  const scaleY = MOUTH_IDLE_SCALE_Y + (MOUTH_OPEN_SCALE_Y - MOUTH_IDLE_SCALE_Y) * clampedLevel;
  return {
    scaleY,
    centerY: MOUTH_TOP_Y - scaleY / 2,
    teethY: TEETH_IDLE_Y - (scaleY - MOUTH_IDLE_SCALE_Y) * TEETH_MOUTH_TRAVEL_RATIO,
  };
}

function hashUserId(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function pick<T>(values: readonly [T, ...T[]], seed: number): T {
  const picked = values[seed % values.length];
  return picked === undefined ? values[0] : picked;
}

export function automaticVoiceAvatarConfig(userId: string, outfitColor: string): VoiceAvatarConfig {
  const seed = hashUserId(userId);
  return {
    version: 2,
    // Keep the original automatic pools stable so existing users retain the same identity. The
    // expanded options are available when a user chooses to customize their avatar.
    skinTone: pick(VOICE_AVATAR_LEGACY_SKIN_TONES, seed),
    hairColor: pick(VOICE_AVATAR_LEGACY_HAIR_COLORS, seed >>> 4),
    hairStyle: pick(VOICE_AVATAR_LEGACY_HAIR_STYLES, seed >>> 8),
    eyeColor: "dark-brown",
    glassesStyle: ((seed >>> 12) & 3) === 0 ? "round" : "none",
    facialHairStyle: ((seed >>> 14) & 3) === 0 ? "full-beard" : "none",
    outfitColor,
  };
}

export function avatarStyleForUser(userId: string, config?: VoiceAvatarConfig): VoiceAvatarStyle {
  const resolved = config ?? automaticVoiceAvatarConfig(userId, "#8b5cf6");
  return {
    skin: VOICE_AVATAR_SKIN_HEX[resolved.skinTone],
    hair: VOICE_AVATAR_HAIR_HEX[resolved.hairColor],
    eyes: VOICE_AVATAR_EYE_HEX[resolved.eyeColor],
    hairStyle: resolved.hairStyle,
    glassesStyle: resolved.glassesStyle,
    facialHairStyle: resolved.facialHairStyle,
  };
}

export function voiceLoungeColumns(memberCount: number): number {
  if (memberCount <= 0) return 0;
  if (memberCount <= 5) return memberCount;
  return Math.min(5, Math.ceil(memberCount / 2));
}

function createTrackedGeometry<T extends BufferGeometry>(
  geometries: BufferGeometry[],
  geometry: T,
): T {
  geometries.push(geometry);
  return geometry;
}

function createTrackedMaterial<T extends Material>(materials: Material[], material: T): T {
  materials.push(material);
  return material;
}

function addMesh(parent: Group, mesh: Mesh): Mesh {
  parent.add(mesh);
  return mesh;
}

function addHair(
  three: ThreeModule,
  head: Group,
  style: VoiceAvatarStyle,
  geometries: BufferGeometry[],
  materials: Material[],
): void {
  if (style.hairStyle === "bald") return;

  const material = createTrackedMaterial(
    materials,
    new three.MeshStandardMaterial({ color: style.hair, roughness: 0.9, flatShading: true }),
  );
  const round = (radius = 0.24): Mesh =>
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(radius, 8, 6)),
      material,
    );
  const addRound = (
    x: number,
    y: number,
    scaleX = 1,
    scaleY = scaleX,
    scaleZ = scaleX,
    z = -0.01,
  ): Mesh => {
    const piece = addMesh(head, round());
    piece.position.set(x, y, z);
    piece.scale.set(scaleX, scaleY, scaleZ);
    return piece;
  };

  if (style.hairStyle === "short") {
    for (const [x, y, scale] of [
      [-0.42, 0.56, 1],
      [-0.2, 0.7, 1.15],
      [0.04, 0.75, 1.2],
      [0.28, 0.67, 1.05],
      [0.45, 0.52, 0.9],
    ] as const) {
      addRound(x, y, scale, scale, scale, 0.02);
    }
    return;
  }

  if (style.hairStyle === "spiked") {
    for (const [x, y, rotation] of [
      [-0.38, 0.58, -0.35],
      [-0.12, 0.75, -0.15],
      [0.15, 0.77, 0.12],
      [0.4, 0.6, 0.32],
    ] as const) {
      const spike = addMesh(
        head,
        new three.Mesh(
          createTrackedGeometry(geometries, new three.ConeGeometry(0.24, 0.5, 6)),
          material,
        ),
      );
      spike.position.set(x, y, 0.02);
      spike.rotation.z = rotation;
    }
    return;
  }

  if (style.hairStyle === "curly") {
    for (const [x, y, sy] of [
      [-0.48, 0.42, 1.5],
      [-0.34, 0.66, 1.2],
      [-0.1, 0.75, 1],
      [0.15, 0.74, 1],
      [0.38, 0.62, 1.25],
      [0.49, 0.38, 1.45],
    ] as const) {
      addRound(x, y, 1, sy);
    }
    return;
  }

  if (style.hairStyle === "bun") {
    addRound(0, 0.65, 2.2, 1.05, 1.65, -0.02);
    addRound(0.34, 0.92, 0.9, 0.9, 0.9, -0.1);
    return;
  }

  if (style.hairStyle === "buzz") {
    const cap = addMesh(
      head,
      new three.Mesh(
        createTrackedGeometry(geometries, new three.SphereGeometry(0.58, 12, 8)),
        material,
      ),
    );
    cap.position.set(0, 0.35, -0.08);
    cap.scale.set(1, 0.68, 0.94);
    return;
  }

  if (style.hairStyle === "wavy") {
    for (const [x, y, rotation] of [
      [-0.43, 0.48, -0.28],
      [-0.25, 0.66, 0.18],
      [-0.02, 0.7, -0.14],
      [0.22, 0.68, 0.2],
      [0.43, 0.5, -0.2],
    ] as const) {
      const wave = addRound(x, y, 1.35, 0.72, 1.05, 0.01);
      wave.rotation.z = rotation;
    }
    return;
  }

  if (style.hairStyle === "coily") {
    for (const [x, y, scale] of [
      [-0.5, 0.36, 1],
      [-0.46, 0.58, 1.05],
      [-0.33, 0.74, 1.08],
      [-0.13, 0.83, 1.08],
      [0.09, 0.84, 1.08],
      [0.3, 0.76, 1.08],
      [0.46, 0.59, 1.05],
      [0.5, 0.36, 1],
      [-0.28, 0.52, 1],
      [-0.05, 0.59, 1.02],
      [0.19, 0.56, 1.02],
    ] as const) {
      const coil = addMesh(head, round(0.14));
      coil.position.set(x, y, 0);
      coil.scale.setScalar(scale);
    }
    return;
  }

  if (style.hairStyle === "locs") {
    addRound(0, 0.66, 2.15, 0.9, 1.55, -0.03);
    for (const [x, y, length, rotation] of [
      [-0.48, 0.24, 0.58, -0.08],
      [-0.38, 0.31, 0.68, -0.04],
      [-0.27, 0.39, 0.54, -0.02],
      [0.28, 0.39, 0.54, 0.02],
      [0.39, 0.31, 0.68, 0.04],
      [0.49, 0.24, 0.58, 0.08],
    ] as const) {
      const loc = addMesh(
        head,
        new three.Mesh(
          createTrackedGeometry(geometries, new three.CylinderGeometry(0.055, 0.065, length, 6)),
          material,
        ),
      );
      loc.position.set(x, y, 0.07);
      loc.rotation.z = rotation;
    }
    return;
  }

  if (style.hairStyle === "ponytail") {
    addRound(0, 0.64, 2.18, 0.98, 1.62, -0.04);
    for (const [x, y, scale] of [
      [0.5, 0.51, 0.95],
      [0.58, 0.27, 0.82],
      [0.59, 0.04, 0.72],
      [0.56, -0.15, 0.62],
    ] as const) {
      addRound(x, y, scale, 1.1 * scale, scale, -0.1);
    }
    return;
  }

  const unsupportedHairStyle: never = style.hairStyle;
  throw new Error(`Unsupported voice avatar hair style: ${unsupportedHairStyle}`);
}

function addEye(
  three: ThreeModule,
  head: Group,
  x: number,
  irisColor: string,
  geometries: BufferGeometry[],
  materials: Material[],
): Group {
  const eye = new three.Group();
  eye.position.set(x, 0.18, 0.55);
  const white = addMesh(
    eye,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(0.13, 12, 8)),
      createTrackedMaterial(
        materials,
        new three.MeshStandardMaterial({ color: "#fffaf5", roughness: 0.65 }),
      ),
    ),
  );
  white.scale.set(1, 1.15, 0.45);
  const iris = addMesh(
    eye,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(0.073, 10, 7)),
      createTrackedMaterial(
        materials,
        new three.MeshStandardMaterial({ color: irisColor, roughness: 0.5 }),
      ),
    ),
  );
  iris.position.z = 0.102;
  iris.scale.z = 0.4;
  const pupil = addMesh(
    eye,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(0.034, 10, 6)),
      createTrackedMaterial(
        materials,
        new three.MeshStandardMaterial({ color: "#16161d", roughness: 0.45 }),
      ),
    ),
  );
  pupil.position.z = 0.13;
  pupil.scale.z = 0.4;
  head.add(eye);
  return eye;
}

function addFacialHair(
  three: ThreeModule,
  head: Group,
  style: VoiceAvatarStyle,
  hairMaterial: Material,
  geometries: BufferGeometry[],
): void {
  if (style.facialHairStyle === "none") return;

  const pieceGeometry = createTrackedGeometry(geometries, new three.SphereGeometry(0.19, 8, 6));
  const addPiece = (
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    rotation = 0,
    z = 0.38,
  ): void => {
    const piece = addMesh(head, new three.Mesh(pieceGeometry, hairMaterial));
    piece.position.set(x, y, z);
    piece.scale.set(scaleX, scaleY, scaleZ);
    piece.rotation.z = rotation;
  };
  const addMustache = (): void => {
    addPiece(-0.095, -0.2, 0.72, 0.24, 0.32, 0.12, 0.58);
    addPiece(0.095, -0.2, 0.72, 0.24, 0.32, -0.12, 0.58);
  };

  if (style.facialHairStyle === "stubble") {
    const stubbleGeometry = createTrackedGeometry(
      geometries,
      new three.SphereGeometry(0.027, 6, 4),
    );
    for (const [x, y] of [
      [-0.32, -0.29],
      [-0.23, -0.39],
      [-0.11, -0.45],
      [0, -0.48],
      [0.11, -0.45],
      [0.23, -0.39],
      [0.32, -0.29],
    ] as const) {
      const dot = addMesh(head, new three.Mesh(stubbleGeometry, hairMaterial));
      dot.position.set(x, y, 0.54);
      dot.scale.z = 0.35;
    }
    return;
  }

  if (style.facialHairStyle === "mustache") {
    addMustache();
    return;
  }

  if (style.facialHairStyle === "goatee") {
    addMustache();
    addPiece(0, -0.43, 0.62, 0.76, 0.42, 0, 0.42);
    return;
  }

  if (style.facialHairStyle === "short-beard") {
    for (const [x, y, scale] of [
      [-0.2, -0.36, 0.72],
      [0, -0.43, 0.88],
      [0.2, -0.36, 0.72],
    ] as const) {
      addPiece(x, y, scale, 0.5, 0.44, 0, 0.4);
    }
    return;
  }

  if (style.facialHairStyle === "full-beard") {
    for (const [x, y, scale] of [
      [-0.23, -0.36, 1],
      [0, -0.46, 1.2],
      [0.23, -0.36, 1],
    ] as const) {
      addPiece(x, y, scale, 0.75, 0.55);
    }
    return;
  }

  const unsupportedFacialHair: never = style.facialHairStyle;
  throw new Error(`Unsupported voice avatar facial hair: ${unsupportedFacialHair}`);
}

function addGlasses(
  three: ThreeModule,
  head: Group,
  style: VoiceAvatarStyle,
  geometries: BufferGeometry[],
  materials: Material[],
): void {
  if (style.glassesStyle === "none") return;

  const frameMaterial = createTrackedMaterial(
    materials,
    new three.MeshStandardMaterial({ color: "#20222b", roughness: 0.35, metalness: 0.2 }),
  );
  const addBridge = (y = 0.18): void => {
    const bridge = addMesh(
      head,
      new three.Mesh(
        createTrackedGeometry(geometries, new three.BoxGeometry(0.13, 0.025, 0.025)),
        frameMaterial,
      ),
    );
    bridge.position.set(0, y, 0.68);
  };

  if (style.glassesStyle === "square") {
    const horizontal = createTrackedGeometry(geometries, new three.BoxGeometry(0.3, 0.025, 0.025));
    const vertical = createTrackedGeometry(geometries, new three.BoxGeometry(0.025, 0.25, 0.025));
    for (const centerX of [-0.23, 0.23]) {
      for (const y of [0.055, 0.305]) {
        const bar = addMesh(head, new three.Mesh(horizontal, frameMaterial));
        bar.position.set(centerX, y, 0.67);
      }
      for (const x of [centerX - 0.15, centerX + 0.15]) {
        const bar = addMesh(head, new three.Mesh(vertical, frameMaterial));
        bar.position.set(x, 0.18, 0.67);
      }
    }
    addBridge();
    return;
  }

  if (
    style.glassesStyle !== "round" &&
    style.glassesStyle !== "aviator" &&
    style.glassesStyle !== "sunglasses"
  ) {
    const unsupportedGlasses: never = style.glassesStyle;
    throw new Error(`Unsupported voice avatar glasses: ${unsupportedGlasses}`);
  }

  const rimGeometry = createTrackedGeometry(
    geometries,
    new three.TorusGeometry(0.16, 0.018, 6, 16),
  );
  for (const x of [-0.23, 0.23]) {
    const rim = addMesh(head, new three.Mesh(rimGeometry, frameMaterial));
    rim.position.set(x, style.glassesStyle === "aviator" ? 0.16 : 0.18, 0.67);
    if (style.glassesStyle === "aviator") rim.scale.set(1.12, 0.86, 1);
  }

  if (style.glassesStyle === "sunglasses") {
    const lensMaterial = createTrackedMaterial(
      materials,
      new three.MeshStandardMaterial({
        color: "#111827",
        roughness: 0.3,
        transparent: true,
        opacity: 0.86,
      }),
    );
    const lensGeometry = createTrackedGeometry(geometries, new three.CircleGeometry(0.145, 12));
    for (const x of [-0.23, 0.23]) {
      const lens = addMesh(head, new three.Mesh(lensGeometry, lensMaterial));
      lens.position.set(x, 0.18, 0.665);
    }
  }

  addBridge(style.glassesStyle === "aviator" ? 0.2 : 0.18);
}

function createAvatarRig(
  three: ThreeModule,
  member: VoiceAvatarMember,
  geometries: BufferGeometry[],
  materials: Material[],
): AvatarRig {
  const seed = hashUserId(member.userId);
  const style = avatarStyleForUser(member.userId, member.voiceAvatar);
  const root = new three.Group();
  const head = new three.Group();
  head.position.y = 0.18;
  root.add(head);

  const hoodieMaterial = createTrackedMaterial(
    materials,
    new three.MeshStandardMaterial({
      color: member.voiceAvatar?.outfitColor ?? member.color,
      roughness: 0.82,
      flatShading: true,
    }),
  );
  const shoulders = addMesh(
    root,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(0.72, 12, 8)),
      hoodieMaterial,
    ),
  );
  shoulders.position.y = -0.84;
  shoulders.scale.set(1.35, 0.55, 0.6);

  const skinMaterial = createTrackedMaterial(
    materials,
    new three.MeshStandardMaterial({ color: style.skin, roughness: 0.72, flatShading: true }),
  );
  const neck = addMesh(
    root,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.CylinderGeometry(0.18, 0.22, 0.5, 10)),
      skinMaterial,
    ),
  );
  neck.position.y = -0.55;

  const face = addMesh(
    head,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(0.61, 16, 12)),
      skinMaterial,
    ),
  );
  face.scale.set(0.92 + ((seed >>> 18) & 3) * 0.025, 1.08, 0.92);

  const earGeometry = createTrackedGeometry(geometries, new three.SphereGeometry(0.12, 10, 7));
  for (const x of [-0.59, 0.59]) {
    const ear = addMesh(head, new three.Mesh(earGeometry, skinMaterial));
    ear.position.set(x, 0.02, 0);
    ear.scale.z = 0.65;
  }

  const leftEye = addEye(three, head, -0.23, style.eyes, geometries, materials);
  const rightEye = addEye(three, head, 0.23, style.eyes, geometries, materials);

  const browGeometry = createTrackedGeometry(geometries, new three.BoxGeometry(0.2, 0.035, 0.04));
  const hairMaterial = createTrackedMaterial(
    materials,
    new three.MeshStandardMaterial({ color: style.hair, roughness: 0.9 }),
  );
  for (const x of [-0.23, 0.23]) {
    const brow = addMesh(head, new three.Mesh(browGeometry, hairMaterial));
    brow.position.set(x, 0.37, 0.57);
    brow.rotation.z = x < 0 ? -0.08 : 0.08;
  }

  const nose = addMesh(
    head,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.ConeGeometry(0.07, 0.18, 8)),
      skinMaterial,
    ),
  );
  nose.position.set(0, -0.02, 0.64);
  nose.rotation.x = Math.PI / 2;

  const mouth = new three.Group();
  mouth.position.set(0, -0.27, 0.57);
  const mouthInner = addMesh(
    mouth,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.SphereGeometry(0.5, 12, 8)),
      createTrackedMaterial(
        materials,
        new three.MeshStandardMaterial({ color: "#32131a", roughness: 0.78 }),
      ),
    ),
  );
  const idleMouthPose = voiceAvatarMouthPose(0);
  mouthInner.position.y = idleMouthPose.centerY;
  mouthInner.scale.set(0.42, idleMouthPose.scaleY, 0.12);
  const teeth = addMesh(
    mouth,
    new three.Mesh(
      createTrackedGeometry(geometries, new three.BoxGeometry(0.27, 0.055, 0.035)),
      createTrackedMaterial(
        materials,
        new three.MeshStandardMaterial({ color: "#fff9ed", roughness: 0.65 }),
      ),
    ),
  );
  teeth.position.set(0, idleMouthPose.teethY, 0.048);
  head.add(mouth);

  addFacialHair(three, head, style, hairMaterial, geometries);
  addGlasses(three, head, style, geometries, materials);

  addHair(three, head, style, geometries, materials);

  return {
    userId: member.userId,
    muted: member.muted,
    seed,
    root,
    head,
    mouthInner,
    teeth,
    leftEye,
    rightEye,
    level: 0,
  };
}

export function createVoiceAvatarStage(
  three: ThreeModule,
  canvas: HTMLCanvasElement,
  members: VoiceAvatarMember[],
): VoiceAvatarStage {
  const renderer: WebGLRenderer = new three.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = three.SRGBColorSpace;
  renderer.toneMapping = three.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene: Scene = new three.Scene();
  const camera: OrthographicCamera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
  camera.position.z = 8;

  scene.add(new three.HemisphereLight(0xb8c0ff, 0x17121f, 2.2));
  const keyLight = new three.DirectionalLight(0xffffff, 3.4);
  keyLight.position.set(-3, 5, 6);
  scene.add(keyLight);
  const rimLight = new three.DirectionalLight(0x8b5cf6, 2.1);
  rimLight.position.set(4, 2, 2);
  scene.add(rimLight);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const rigs = members.map((member) => {
    const rig = createAvatarRig(three, member, geometries, materials);
    scene.add(rig.root);
    return rig;
  });
  const columns = voiceLoungeColumns(members.length);
  const rows = columns === 0 ? 0 : Math.ceil(members.length / columns);

  const resize = (width: number, height: number): void => {
    if (width <= 0 || height <= 0 || columns === 0 || rows === 0) return;
    renderer.setSize(width, height, false);
    const worldHeight = rows * 2.55;
    const worldWidth = worldHeight * (width / height);
    camera.left = -worldWidth / 2;
    camera.right = worldWidth / 2;
    camera.top = worldHeight / 2;
    camera.bottom = -worldHeight / 2;
    camera.updateProjectionMatrix();

    const cellWidth = worldWidth / columns;
    const cellHeight = worldHeight / rows;
    for (const [index, rig] of rigs.entries()) {
      const row = Math.floor(index / columns);
      const firstInRow = row * columns;
      const rowCount = Math.min(columns, rigs.length - firstInRow);
      const column = index - firstInRow;
      rig.root.position.set(
        (column - (rowCount - 1) / 2) * cellWidth,
        worldHeight / 2 - (row + 0.5) * cellHeight + 0.04,
        0,
      );
      const scale = Math.max(0.62, Math.min(1.08, cellWidth / 2.05, cellHeight / 2.45));
      rig.root.scale.setScalar(scale);
    }
  };

  const render = (
    timeMs: number,
    motionEnabled: boolean,
    readLevel: (userId: string, timeMs: number) => number,
  ): void => {
    const seconds = timeMs / 1_000;
    for (const rig of rigs) {
      const rawTarget = motionEnabled && !rig.muted ? readLevel(rig.userId, timeMs) : 0;
      const target = Math.max(0, Math.min(1, rawTarget));
      const response = target > rig.level ? 0.36 : 0.16;
      rig.level += (target - rig.level) * response;
      const mouthPose = voiceAvatarMouthPose(rig.level);
      rig.mouthInner.position.y = mouthPose.centerY;
      rig.mouthInner.scale.y = mouthPose.scaleY;
      rig.teeth.position.y = mouthPose.teethY;

      if (motionEnabled) {
        const phase = (rig.seed % 997) / 997;
        const blinkCycle = (seconds + phase * 4.2) % (3.6 + phase * 1.8);
        const blink = blinkCycle < 0.13 ? Math.max(0.08, Math.abs(blinkCycle - 0.065) / 0.065) : 1;
        rig.leftEye.scale.y = blink;
        rig.rightEye.scale.y = blink;
        rig.head.position.y = 0.18 + Math.sin(seconds * 7 + phase * 8) * rig.level * 0.045;
        rig.head.rotation.z = Math.sin(seconds * 3.2 + phase * 6) * rig.level * 0.045;
        rig.head.rotation.y = Math.sin(seconds * 0.65 + phase * 5) * 0.055;
      } else {
        rig.leftEye.scale.y = 1;
        rig.rightEye.scale.y = 1;
        rig.head.position.y = 0.18;
        rig.head.rotation.set(0, 0, 0);
      }
    }
    renderer.render(scene, camera);
  };

  return {
    resize,
    render,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      renderer.dispose();
    },
  };
}
