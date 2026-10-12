/**
 * Manual part numbers per work order, shared with everyone.
 *
 * Sage's Open Orders export sometimes carries only a non-part line for a work order
 * (e.g. CCSERVICECHARGE). When someone uploads with a part number that is not in the
 * export for that WO, it is saved here so the next person sees the real part.
 */
import { getPool, isDatabaseConfigured } from "./db";
import { getPartNumbersByWorkOrder } from "./excelParser";

export type PartOption = {
  partNumber: string;
  rev: string;
  customerName: string;
  source: "excel" | "manual";
  nonPart: boolean;
  id?: string;
  addedBy?: string;
  canDelete?: boolean;
};

export type Viewer = { userId: string | null; isAdmin: boolean };

const MAX_PART = 100;
const MAX_REV = 20;
const NON_PART_RE = /SERVICE\s*CHARGE|FREIGHT|EXPEDITE/i;

function normalize(code: string): string {
  return code.toUpperCase().replace(/\s+/g, "");
}

function nonPartCodes(): Set<string> {
  const raw = process.env.IMAGEFLOW_NON_PART_CODES?.trim() || "CCSERVICECHARGE";
  return new Set(raw.split(",").map((c) => normalize(c)).filter(Boolean));
}

/** Sage line items that are charges, not parts (warning only; still selectable). */
export function isNonPartCode(code: string): boolean {
  return nonPartCodes().has(normalize(code)) || NON_PART_RE.test(code);
}

let ensurePromise: Promise<void> | null = null;

export async function ensurePartOverridesTable(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [874203154]);
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS imageflow_part_overrides (
              id bigserial PRIMARY KEY,
              work_order_number text NOT NULL,
              part_number text NOT NULL,
              rev text NOT NULL DEFAULT '',
              customer_name text NOT NULL DEFAULT '',
              created_by_id text NOT NULL,
              created_by_email text NOT NULL DEFAULT '',
              created_by_name text NOT NULL DEFAULT '',
              created_at timestamptz NOT NULL DEFAULT now(),
              last_used_at timestamptz NOT NULL DEFAULT now(),
              use_count integer NOT NULL DEFAULT 1,
              UNIQUE (work_order_number, part_number, rev)
            );
          `);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [874203154]);
        }
      } finally {
        client.release();
      }
    })().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  await ensurePromise;
}

type OverrideRow = {
  id: string;
  part_number: string;
  rev: string;
  customer_name: string;
  created_by_id: string;
  created_by_name: string;
};

function sameKey(a: { partNumber: string; rev: string }, b: { partNumber: string; rev: string }): boolean {
  return normalize(a.partNumber) === normalize(b.partNumber) && normalize(a.rev) === normalize(b.rev);
}

/** Excel parts first (flagged when they are charge lines), then saved manual parts, most recently used first. */
export async function listPartOptions(workOrder: string, viewer: Viewer): Promise<PartOption[]> {
  const excel: PartOption[] = getPartNumbersByWorkOrder(workOrder).map((p) => ({
    ...p,
    source: "excel",
    nonPart: isNonPartCode(p.partNumber),
  }));
  if (!isDatabaseConfigured()) return excel;
  let rows: OverrideRow[] = [];
  try {
    await ensurePartOverridesTable();
    rows = (
      await getPool().query<OverrideRow>(
        `SELECT id::text AS id, part_number, rev, customer_name, created_by_id, created_by_name
           FROM imageflow_part_overrides
          WHERE work_order_number = $1
          ORDER BY last_used_at DESC
          LIMIT 50`,
        [workOrder],
      )
    ).rows;
  } catch (err) {
    console.warn("[parts] could not read manual part numbers:", (err as Error).message);
  }
  const manual: PartOption[] = rows
    .map((r) => ({
      partNumber: r.part_number,
      rev: r.rev,
      customerName: r.customer_name || excel[0]?.customerName || "",
      source: "manual" as const,
      nonPart: false,
      id: r.id,
      addedBy: r.created_by_name,
      canDelete: viewer.isAdmin || (viewer.userId !== null && viewer.userId === r.created_by_id),
    }))
    .filter((m) => !excel.some((e) => sameKey(e, m)));
  return [...excel, ...manual];
}

export type ManualPartInput = {
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  customerName: string;
  userId: string;
  userEmail: string;
  userName: string;
};

/** Save a part typed in by hand; no-op when it already comes from the Excel export. */
export async function recordManualPart(input: ManualPartInput): Promise<"saved" | "skipped"> {
  if (!isDatabaseConfigured()) return "skipped";
  const workOrder = input.workOrderNumber.trim();
  const partNumber = input.partNumber.trim().slice(0, MAX_PART);
  const rev = input.rev.trim().slice(0, MAX_REV);
  if (!workOrder || !partNumber || isNonPartCode(partNumber)) return "skipped";
  const excel = getPartNumbersByWorkOrder(workOrder);
  if (excel.some((e) => sameKey(e, { partNumber, rev }))) return "skipped";

  await ensurePartOverridesTable();
  await getPool().query(
    `INSERT INTO imageflow_part_overrides
       (work_order_number, part_number, rev, customer_name, created_by_id, created_by_email, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (work_order_number, part_number, rev)
     DO UPDATE SET use_count = imageflow_part_overrides.use_count + 1,
                   last_used_at = now(),
                   customer_name = EXCLUDED.customer_name`,
    [workOrder, partNumber, rev, input.customerName.trim().slice(0, 200), input.userId, input.userEmail, input.userName],
  );
  return "saved";
}

/** Swallows errors: saving a manual part must never fail an upload. */
export async function recordManualPartSafely(input: ManualPartInput): Promise<void> {
  try {
    await recordManualPart(input);
  } catch (err) {
    console.warn("[parts] could not save manual part number:", (err as Error).message);
  }
}

export async function deleteManualPart(
  workOrder: string,
  id: string,
  viewer: Viewer,
): Promise<"deleted" | "not_found" | "forbidden"> {
  await ensurePartOverridesTable();
  const found = await getPool().query<{ created_by_id: string }>(
    `SELECT created_by_id FROM imageflow_part_overrides WHERE id = $1 AND work_order_number = $2`,
    [id, workOrder],
  );
  const row = found.rows[0];
  if (!row) return "not_found";
  if (!viewer.isAdmin && viewer.userId !== row.created_by_id) return "forbidden";
  await getPool().query(`DELETE FROM imageflow_part_overrides WHERE id = $1`, [id]);
  return "deleted";
}
