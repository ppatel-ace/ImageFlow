import { MAX_EDGE_PX, JPEG_QUALITY, THUMB_EDGE_PX, THUMB_QUALITY } from "./compressSettings";

type Request = { id: string; file: Blob };

async function renderJpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage: (msg: unknown) => void;
};

scope.onmessage = async (e) => {
  const { id, file } = e.data;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const blob = await renderJpeg(bitmap, MAX_EDGE_PX, JPEG_QUALITY);
      const thumb = await renderJpeg(bitmap, THUMB_EDGE_PX, THUMB_QUALITY);
      scope.postMessage({ id, blob, thumb });
    } finally {
      bitmap.close();
    }
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
