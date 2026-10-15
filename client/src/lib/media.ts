/** Must match the server's upload limits in `server/routes.ts`. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);

export function isVideoExt(ext: string | null | undefined): boolean {
  return VIDEO_EXTENSIONS.has((ext || "").toLowerCase());
}

export function isVideoBlob(blob: Blob | null | undefined): boolean {
  return Boolean(blob?.type && blob.type.toLowerCase().startsWith("video/"));
}

export function videoExtension(file: Blob): string {
  const name = file instanceof File ? file.name : "";
  const fromName = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (isVideoExt(fromName)) return fromName === "m4v" ? "mp4" : fromName;
  if (/webm/i.test(file.type)) return "webm";
  if (/quicktime/i.test(file.type)) return "mov";
  return "mp4";
}
