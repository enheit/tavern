import { LIMITS } from "@tavern/shared";

// FR-05 client-side avatar prep: center-square-crop the chosen image and re-encode it to a 256×256
// webp before upload. Only the three raster types the worker accepts are allowed; the result is
// size-guarded against `LIMITS.avatarMaxBytes` so a too-large blob fails here (typed) rather than at
// the POST.
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class UnsupportedImageError extends Error {
  constructor() {
    super("unsupported_media");
    this.name = "UnsupportedImageError";
  }
}

export class AvatarTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "AvatarTooLargeError";
  }
}

function encodeWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error("canvas_encode_failed"));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      0.9,
    );
  });
}

export async function resizeToWebp(file: File, size = 256): Promise<Blob> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new UnsupportedImageError();

  const bitmap = await createImageBitmap(file);
  try {
    // Center square crop: take the largest centered square of the source, then scale it to size×size.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas_context_unavailable");
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);

    const blob = await encodeWebp(canvas);
    if (blob.size > LIMITS.avatarMaxBytes) throw new AvatarTooLargeError();
    return blob;
  } finally {
    bitmap.close();
  }
}
