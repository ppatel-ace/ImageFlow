/**
 * Text stamp burned into the bottom-left of a photo: work order / part / date, or
 * free text on custom work orders. Shared by the compress worker and the main thread.
 */
export type PhotoStamp = { lines: string[] };

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const MAX_LINES = 3;
const MAX_LINE_CHARS = 120;

export function normalizeStamp(stamp: PhotoStamp | null | undefined): PhotoStamp | null {
  if (!stamp) return null;
  const lines = stamp.lines
    .map((l) => l.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LINES);
  return lines.length ? { lines } : null;
}

/** Stable key so a photo is only re-stamped when the text actually changes. */
export function stampKey(stamp: PhotoStamp | null | undefined): string {
  return normalizeStamp(stamp)?.lines.join("\n") ?? "";
}

function fitLine(ctx: Ctx2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function drawStamp(ctx: Ctx2D, width: number, height: number, stamp: PhotoStamp | null | undefined): void {
  const s = normalizeStamp(stamp);
  if (!s) return;
  const fontPx = Math.max(14, Math.round(Math.min(width, height) * 0.035));
  const pad = Math.round(fontPx * 0.5);
  const lineH = Math.round(fontPx * 1.25);
  const margin = Math.round(fontPx * 0.6);
  ctx.save();
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textBaseline = "top";
  const maxText = width - 2 * margin - 2 * pad;
  const lines = s.lines.map((l) => fitLine(ctx, l, maxText));
  const boxW = Math.min(width - 2 * margin, Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 2 * pad);
  const boxH = lines.length * lineH + 2 * pad - (lineH - fontPx);
  const x = margin;
  const y = height - margin - boxH;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = "#ffffff";
  lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + i * lineH));
  ctx.restore();
}

export function formatStampDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
