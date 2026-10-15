/**
 * Resize/compress an image for SharePoint upload and build a small preview thumbnail.
 * Runs in a Web Worker (OffscreenCanvas) when available so capture stays responsive;
 * falls back to the main thread, then to the original file if decoding fails.
 */
import { MAX_EDGE_PX, JPEG_QUALITY, THUMB_EDGE_PX, THUMB_QUALITY } from "./compressSettings";
import { drawStamp, type PhotoStamp } from "./photoStamp";

export type PreparedImage = {
  blob: Blob;
  thumb: Blob;
  compressMs: number;
};

type WorkerReply = { id: string; blob?: Blob; thumb?: Blob; error?: string };

let worker: Worker | null = null;
let workerBroken = false;
const pending = new Map<string, (reply: WorkerReply) => void>();
let seq = 0;

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./compressImage.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const resolve = pending.get(e.data.id);
      if (resolve) {
        pending.delete(e.data.id);
        resolve(e.data);
      }
    };
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const [id, resolve] of Array.from(pending.entries())) {
        resolve({ id, error: "compress worker crashed" });
      }
      pending.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function prepareInWorker(file: Blob, stamp: PhotoStamp | null): Promise<WorkerReply> | null {
  const w = getWorker();
  if (!w) return null;
  const id = String(++seq);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, file, stamp });
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function prepareOnMainThread(file: Blob, stamp: PhotoStamp | null): Promise<{ blob: Blob; thumb: Blob } | null> {
  if (typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    drawStamp(ctx, canvas.width, canvas.height, stamp);
    const blob = await canvasToJpeg(canvas, JPEG_QUALITY);

    const tScale = Math.min(1, THUMB_EDGE_PX / Math.max(canvas.width, canvas.height));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = Math.max(1, Math.round(canvas.width * tScale));
    thumbCanvas.height = Math.max(1, Math.round(canvas.height * tScale));
    thumbCanvas.getContext("2d")?.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = await canvasToJpeg(thumbCanvas, THUMB_QUALITY);
    if (!blob || !thumb) return null;
    return { blob, thumb };
  } finally {
    bitmap.close();
  }
}

/** `stamped` is false only when the photo couldn't be decoded and the original is sent as-is. */
export async function prepareImageForUpload(
  file: Blob,
  stamp: PhotoStamp | null = null,
): Promise<PreparedImage & { stamped: boolean }> {
  const started = performance.now();
  try {
    const viaWorker = prepareInWorker(file, stamp);
    if (viaWorker) {
      const reply = await viaWorker;
      if (reply.blob && reply.thumb) {
        return { blob: reply.blob, thumb: reply.thumb, compressMs: performance.now() - started, stamped: true };
      }
    }
    const main = await prepareOnMainThread(file, stamp);
    if (main) return { ...main, compressMs: performance.now() - started, stamped: true };
  } catch {
    /* fall through to original */
  }
  return { blob: file, thumb: file, compressMs: performance.now() - started, stamped: !stamp };
}

/** Back-compat helper: compressed File only. */
export async function compressImageForUpload(file: File): Promise<File> {
  const { blob } = await prepareImageForUpload(file);
  if (blob === file) return file;
  const stem = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}
