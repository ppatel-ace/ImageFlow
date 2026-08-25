import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

export type SaveImageResult =
  | { ok: true; method: "native" | "download"; path?: string }
  | { ok: false; error: string };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read image as base64"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

function extensionFor(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && fromName.length <= 5) return fromName;
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function buildFilename(file: File): string {
  return `ImageFlow-${Date.now()}.${extensionFor(file)}`;
}

function downloadViaAnchor(file: File, filename: string): void {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function ensureFilesystemPermission(): Promise<boolean> {
  try {
    const status = await Filesystem.checkPermissions();
    if (status.publicStorage === "granted") return true;
    const requested = await Filesystem.requestPermissions();
    return requested.publicStorage === "granted";
  } catch {
    // Some platforms do not expose publicStorage; attempt write anyway.
    return true;
  }
}

async function writeNative(file: File, filename: string): Promise<string> {
  const data = await fileToBase64(file);
  const relativePath = `Pictures/ImageFlow/${filename}`;

  await ensureFilesystemPermission();

  try {
    const result = await Filesystem.writeFile({
      path: relativePath,
      data,
      directory: Directory.ExternalStorage,
      recursive: true,
    });
    return result.uri ?? relativePath;
  } catch (externalError) {
    // ExternalStorage is unavailable on Android 11+; fall back to Documents.
    console.warn(
      "ExternalStorage write failed, falling back to Documents:",
      externalError
    );
    const fallbackPath = `ImageFlow/${filename}`;
    const result = await Filesystem.writeFile({
      path: fallbackPath,
      data,
      directory: Directory.Documents,
      recursive: true,
    });
    return result.uri ?? fallbackPath;
  }
}

/**
 * Persist a camera-captured image onto the device.
 * Native (Capacitor): Pictures/ImageFlow (or Documents/ImageFlow fallback).
 * Browser: triggers a download in the current user-gesture stack.
 */
export async function saveImageToDevice(file: File): Promise<SaveImageResult> {
  const filename = buildFilename(file);

  try {
    if (Capacitor.isNativePlatform()) {
      const path = await writeNative(file, filename);
      return { ok: true, method: "native", path };
    }

    downloadViaAnchor(file, filename);
    return { ok: true, method: "download" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not save image to device";
    console.error("saveImageToDevice failed:", error);
    return { ok: false, error: message };
  }
}
