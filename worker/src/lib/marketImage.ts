import { LIMITS } from "@tavern/shared";

const ACCEPTED_FORMATS = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class MarketImageError extends Error {
  constructor(readonly code: "unsupported_media" | "payload_too_large") {
    super(code);
    this.name = "MarketImageError";
  }
}

function isInvalidImageError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 9412;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const readNext = async (): Promise<void> => {
    const result = await reader.read();
    if (result.done) return;
    size += result.value.byteLength;
    if (size > limit) throw new MarketImageError("payload_too_large");
    chunks.push(result.value);
    await readNext();
  };
  try {
    await readNext();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

// Animated WebP stores its loop count in the ANIM chunk. Zero is the WebP-defined infinite loop.
// Static WebP has no ANIM chunk and needs no modification.
export function forceInfiniteWebpLoop(input: Uint8Array): Uint8Array {
  if (input.byteLength < 12 || fourCc(input, 0) !== "RIFF" || fourCc(input, 8) !== "WEBP") {
    throw new MarketImageError("unsupported_media");
  }
  const output = input.slice();
  let offset = 12;
  while (offset + 8 <= output.byteLength) {
    const name = fourCc(output, offset);
    const size = u32le(output, offset + 4);
    const payload = offset + 8;
    const next = payload + size + (size % 2);
    if (next > output.byteLength) throw new MarketImageError("unsupported_media");
    if (name === "ANIM") {
      if (size < 6) throw new MarketImageError("unsupported_media");
      output[payload + 4] = 0;
      output[payload + 5] = 0;
      return output;
    }
    offset = next;
  }
  return output;
}

export async function normalizeMarketIcon(images: ImagesBinding, file: File): Promise<Uint8Array> {
  if (file.size > LIMITS.marketIconInputMaxBytes) {
    throw new MarketImageError("payload_too_large");
  }
  const input = new Uint8Array(await file.arrayBuffer());
  let info: ImageInfoResponse;
  try {
    info = await images.info(new Blob([input]).stream());
  } catch (error: unknown) {
    if (isInvalidImageError(error)) throw new MarketImageError("unsupported_media");
    throw error;
  }
  if (!("width" in info) || !ACCEPTED_FORMATS.has(info.format.toLocaleLowerCase())) {
    throw new MarketImageError("unsupported_media");
  }

  const transformed = await images
    .input(new Blob([input]).stream())
    .transform({
      width: LIMITS.marketIconSizePx,
      height: LIMITS.marketIconSizePx,
      fit: "pad",
      background: "rgba(0,0,0,0)",
    })
    .output({ format: "image/webp", quality: 90, anim: true });

  const output = forceInfiniteWebpLoop(
    await readBounded(transformed.image(), LIMITS.marketIconOutputMaxBytes),
  );
  const outputInfo = await images.info(new Blob([output]).stream());
  if (
    !("width" in outputInfo) ||
    outputInfo.format.toLocaleLowerCase() !== "image/webp" ||
    outputInfo.width !== LIMITS.marketIconSizePx ||
    outputInfo.height !== LIMITS.marketIconSizePx
  ) {
    throw new MarketImageError("unsupported_media");
  }
  return output;
}
