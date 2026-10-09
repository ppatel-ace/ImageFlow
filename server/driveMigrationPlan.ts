/**
 * Pure mapping rules for the Google Drive → SharePoint photo migration.
 *
 * Drive (old ImageFlow):  <root>/{Customer}/{Dept}/{WorkOrder}/{photo}
 * SharePoint (ImageFlow): {Dept}/{Customer}/{WorkOrder}/{photo}
 * Anything else:          Old Photos/<original Drive path>/{file}
 */
import { sanitizePathSegment } from "./sharepoint";

export const OLD_PHOTOS_FOLDER = "Old Photos";
export const DEPARTMENTS = ["QC", "Testing", "Production"] as const;
export type Department = (typeof DEPARTMENTS)[number];

const DEPT_ALIASES: Record<string, Department> = {
  qc: "QC",
  quality: "QC",
  qualitycontrol: "QC",
  testing: "Testing",
  test: "Testing",
  production: "Production",
  prod: "Production",
};

const ENTITY_RE = /&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi;
const ENTITY_MAP: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

export function decodeEntities(value: string): string {
  // Twice: ERP exports sometimes double-encode ("&amp;amp;").
  let out = value;
  for (let i = 0; i < 2; i++) {
    out = out.replace(ENTITY_RE, (_m, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return ENTITY_MAP[lower] ?? _m;
    });
  }
  return out;
}

export function hasEntities(value: string): boolean {
  return new RegExp(ENTITY_RE.source, "i").test(value);
}

/** Comparison key: entities decoded, case and punctuation ignored. */
export function nameKey(value: string): string {
  return decodeEntities(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function canonicalDept(folderName: string): Department | null {
  return DEPT_ALIASES[nameKey(folderName)] ?? null;
}

export function cleanSegment(value: string): string {
  return sanitizePathSegment(decodeEntities(value));
}

export type FileClass = { copy: true } | { copy: false; reason: string };

const JUNK_RE = /^(desktop\.ini|thumbs\.db|\.ds_store|~\$.*)$/i;

export function classifyDriveFile(name: string, mimeType: string): FileClass {
  if (JUNK_RE.test(name)) return { copy: false, reason: "System file (not a photo)" };
  if (mimeType.startsWith("application/vnd.google-apps.")) return { copy: false, reason: "Google Docs item (not a photo)" };
  if (mimeType.startsWith("image/")) return { copy: true };
  return { copy: false, reason: `Not a photo (${mimeType || "unknown type"})` };
}

export type MappedTarget =
  | { kind: "mapped"; dept: Department; driveCustomer: string; workOrder: string }
  | { kind: "old_photos"; folder: string };

/** `folders` = Drive folder names from the root down to (excluding) the file. */
export function mapDrivePath(folders: string[]): MappedTarget {
  if (folders.length === 3) {
    const dept = canonicalDept(folders[1]);
    if (dept) return { kind: "mapped", dept, driveCustomer: folders[0], workOrder: cleanSegment(folders[2]) };
  }
  return { kind: "old_photos", folder: [OLD_PHOTOS_FOLDER, ...folders.map(cleanSegment)].join("/") };
}

export type CustomerResolution = { name: string; existing: boolean };
export type PlannedRename = { dept: Department; from: string; to: string };

/**
 * Pick the SharePoint customer folder for a Drive customer under one department.
 * Existing folders win (case/punctuation-insensitive); "&amp;"-style names resolve to
 * their decoded form, which the run renames to before copying.
 */
export function resolveCustomerFolder(driveCustomer: string, existingInDept: string[]): CustomerResolution {
  const key = nameKey(driveCustomer);
  const decoded = cleanSegment(driveCustomer);
  const matches = existingInDept.filter((n) => nameKey(n) === key);
  if (matches.length === 0) return { name: decoded, existing: false };
  const exact = matches.find((n) => n === decoded);
  if (exact) return { name: exact, existing: true };
  const clean = matches.find((n) => !hasEntities(n));
  if (clean) return { name: clean, existing: true };
  return { name: cleanSegment(matches[0]), existing: true };
}

/** Existing "&amp;" folders to rename; skipped when the decoded twin already exists. */
export function planRenames(existingByDept: Record<string, string[]>): { renames: PlannedRename[]; conflicts: PlannedRename[] } {
  const renames: PlannedRename[] = [];
  const conflicts: PlannedRename[] = [];
  for (const dept of DEPARTMENTS) {
    const names = existingByDept[dept] ?? [];
    for (const from of names) {
      if (!hasEntities(from)) continue;
      const to = cleanSegment(from);
      if (to === from) continue;
      (names.includes(to) ? conflicts : renames).push({ dept, from, to });
    }
  }
  return { renames, conflicts };
}

/** "name.jpg" → "name (2).jpg" until unused in `taken` (case-insensitive, SharePoint semantics). */
export function uniqueFileName(folder: string, fileName: string, taken: Set<string>): string {
  const clean = sanitizePathSegment(fileName);
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let candidate = clean;
  for (let n = 2; taken.has(`${folder}/${candidate}`.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(`${folder}/${candidate}`.toLowerCase());
  return candidate;
}
