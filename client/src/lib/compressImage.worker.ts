import { MAX_EDGE_PX, JPEG_QUALITY, THUMB_EDGE_PX, THUMB_QUALITY } from "./compressSettings";
import { drawStamp, type PhotoStamp } from "./photoStamp";

type Request = { id: string; file: Blob; stamp?: PhotoStamp | null };

/** Draw once at upload size (with the stamp), then derive the thumbnail from that canvas. */
async function render(bitmap: ImageBitmap, stamp: PhotoStamp | null | undefined): Promise<{ blob: Blob; thumb: Blob }> {
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  drawStamp(ctx, width, height, stamp);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });

  const tScale = Math.min(1, THUMB_EDGE_PX / Math.max(width, height));
  const thumbCanvas = new OffscreenCanvas(Math.max(1, Math.round(width * tScale)), Math.max(1, Math.round(height * tScale)));
  const tctx = thumbCanvas.getContext("2d");
  if (!tctx) throw new Error("OffscreenCanvas 2d context unavailable");
  tctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: THUMB_QUALITY });
  return { blob, thumb };
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage: (msg: unknown) => void;
};

scope.onmessage = async (e) => {
  const { id, file, stamp } = e.data;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { blob, thumb } = await render(bitmap, stamp);
      scope.postMessage({ id, blob, thumb });
    } finally {
      bitmap.close();
    }
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
