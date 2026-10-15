/**
 * Custom work orders: WO numbers that aren't in the Sage Open Orders export
 * (engineering samples, RMAs, internal jobs). Shared with everyone. Customer and
 * part # are optional for these; a blank customer files under "No Customer".
 */
import { getPool, isDatabaseConfigured } from "./db";
import { getAllWorkOrders } from "./excelParser";

export const NO_CUSTOMER_FOLDER = "No Customer";

export type CustomWorkOrder = {
  id: string;
  workOrderNumber: string;
  customerName: string;
  partNumber: string;
  rev: string;
  note: string;
  createdBy: string;
  createdAt: string;
  canDelete: boolean;
};

export type Viewer = { userId: string | null; isAdmin: boolean };

export type CustomWorkOrderInput = {
  workOrderNumber: string;
  customerName?: string;
  partNumber?: string;
  rev?: string;
  note?: string;
  userId: string;
  userEmail: string;
  userName: string;
};

const WO_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const LOCK_KEY = 874203155;

export class CustomWorkOrderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Same comparison the Work Order box uses: case-insensitive, trailing zeros ignored. */
export function workOrderKey(wo: string): string {
  const trimmed = wo.trim().toUpperCase().replace(/\s+/g, " ");
  return /[1-9]/.test(trimmed) ? trimmed.replace(/0+$/, "") : trimmed;
}

let ensurePromise: Promise<void> | null = null;

export async function ensureCustomWorkOrdersTable(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS imageflow_custom_work_orders (
              id bigserial PRIMARY KEY,
              work_order_number text NOT NULL,
              work_order_key text NOT NULL UNIQUE,
              customer_name text NOT NULL DEFAULT '',
              part_number text NOT NULL DEFAULT '',
              rev text NOT NULL DEFAULT '',
              note text NOT NULL DEFAULT '',
              created_by_id text NOT NULL,
              created_by_email text NOT NULL DEFAULT '',
              created_by_name text NOT NULL DEFAULT '',
              created_at timestamptz NOT NULL DEFAULT now()
            );
          `);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
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

type Row = {
  id: string;
  work_order_number: string;
  customer_name: string;
  part_number: string;
  rev: string;
  note: string;
  created_by_id: string;
  created_by_name: string;
  created_at: Date;
};

function toDto(r: Row, viewer: Viewer): CustomWorkOrder {
  return {
    id: r.id,
    workOrderNumber: r.work_order_number,
    customerName: r.customer_name,
    partNumber: r.part_number,
    rev: r.rev,
    note: r.note,
    createdBy: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(),
    canDelete: viewer.isAdmin || (viewer.userId !== null && viewer.userId === r.created_by_id),
  };
}

const SELECT_COLUMNS = `id::text AS id, work_order_number, customer_name, part_number, rev, note,
  created_by_id, created_by_name, created_at`;

export async function listCustomWorkOrders(viewer: Viewer): Promise<CustomWorkOrder[]> {
  if (!isDatabaseConfigured()) return [];
  await ensureCustomWorkOrdersTable();
  const { rows } = await getPool().query<Row>(
    `SELECT ${SELECT_COLUMNS} FROM imageflow_custom_work_orders ORDER BY created_at DESC LIMIT 2000`,
  );
  return rows.map((r) => toDto(r, viewer));
}

export async function findCustomWorkOrder(workOrder: string): Promise<CustomWorkOrder | null> {
  if (!isDatabaseConfigured() || !workOrder.trim()) return null;
  await ensureCustomWorkOrdersTable();
  const { rows } = await getPool().query<Row>(
    `SELECT ${SELECT_COLUMNS} FROM imageflow_custom_work_orders WHERE work_order_key = $1`,
    [workOrderKey(workOrder)],
  );
  return rows[0] ? toDto(rows[0], { userId: null, isAdmin: false }) : null;
}

const clip = (v: string | undefined, max: number) => (v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function createCustomWorkOrder(input: CustomWorkOrderInput, viewer: Viewer): Promise<CustomWorkOrder> {
  if (!isDatabaseConfigured()) throw new CustomWorkOrderError("Custom work orders need the database (DATABASE_URL).", 503);
  const workOrderNumber = clip(input.workOrderNumber, 40);
  if (!WO_RE.test(workOrderNumber)) {
    throw new CustomWorkOrderError(
      "Work order # must be 1–40 characters: letters, numbers, spaces, dot, dash or underscore.",
      400,
    );
  }
  const key = workOrderKey(workOrderNumber);
  if (getAllWorkOrders().some((wo) => workOrderKey(wo) === key)) {
    throw new CustomWorkOrderError(`${workOrderNumber} is already a Sage work order — pick it from the list.`, 409);
  }
  await ensureCustomWorkOrdersTable();
  const { rows } = await getPool().query<Row>(
    `INSERT INTO imageflow_custom_work_orders
       (work_order_number, work_order_key, customer_name, part_number, rev, note,
        created_by_id, created_by_email, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (work_order_key) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      workOrderNumber,
      key,
      clip(input.customerName, 200),
      clip(input.partNumber, 100),
      clip(input.rev, 20),
      clip(input.note, 500),
      input.userId,
      input.userEmail,
      input.userName,
    ],
  );
  if (!rows[0]) throw new CustomWorkOrderError(`Custom work order ${workOrderNumber} already exists.`, 409);
  return toDto(rows[0], viewer);
}

export async function deleteCustomWorkOrder(
  id: string,
  viewer: Viewer,
): Promise<"deleted" | "not_found" | "forbidden"> {
  await ensureCustomWorkOrdersTable();
  const found = await getPool().query<{ created_by_id: string }>(
    `SELECT created_by_id FROM imageflow_custom_work_orders WHERE id = $1`,
    [id],
  );
  const row = found.rows[0];
  if (!row) return "not_found";
  if (!viewer.isAdmin && viewer.userId !== row.created_by_id) return "forbidden";
  await getPool().query(`DELETE FROM imageflow_custom_work_orders WHERE id = $1`, [id]);
  return "deleted";
}
