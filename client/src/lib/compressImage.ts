/**
 * Resize/compress an image for SharePoint upload and build a small preview thumbnail.
 * Runs in a Web Worker (OffscreenCanvas) when available so capture stays responsive;
 * falls back to the main thread, then to the original file if decoding fails.
 */
import { MAX_EDGE_PX, JPEG_QUALITY, THUMB_EDGE_PX, THUMB_QUALITY } from "./compressSettings";

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

function prepareInWorker(file: Blob): Promise<WorkerReply> | null {
  const w = getWorker();
  if (!w) return null;
  const id = String(++seq);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, file });
  });
}

async function renderOnMainThread(
  bitmap: ImageBitmap,
  maxEdge: number,
  quality: number,
): Promise<Blob | null> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function prepareOnMainThread(file: Blob): Promise<{ blob: Blob; thumb: Blob } | null> {
  if (typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(file);
  try {
    const blob = await renderOnMainThread(bitmap, MAX_EDGE_PX, JPEG_QUALITY);
    const thumb = await renderOnMainThread(bitmap, THUMB_EDGE_PX, THUMB_QUALITY);
    if (!blob || !thumb) return null;
    return { blob, thumb };
  } finally {
    bitmap.close();
  }
}

export async function prepareImageForUpload(file: Blob): Promise<PreparedImage> {
  const started = performance.now();
  try {
    const viaWorker = prepareInWorker(file);
    if (viaWorker) {
      const reply = await viaWorker;
      if (reply.blob && reply.thumb) {
        return { blob: reply.blob, thumb: reply.thumb, compressMs: performance.now() - started };
      }
    }
    const main = await prepareOnMainThread(file);
    if (main) return { ...main, compressMs: performance.now() - started };
  } catch {
    /* fall through to original */
  }
  return { blob: file, thumb: file, compressMs: performance.now() - started };
}

/** Back-compat helper: compressed File only. */
export async function compressImageForUpload(file: File): Promise<File> {
  const { blob } = await prepareImageForUpload(file);
  if (blob === file) return file;
  const stem = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}
