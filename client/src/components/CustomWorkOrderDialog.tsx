import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

const WO_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

interface Props {
  open: boolean;
  initialWorkOrder: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (wo: CustomWorkOrder) => void;
}

export default function CustomWorkOrderDialog({ open, initialWorkOrder, onOpenChange, onCreated }: Props) {
  const [workOrderNumber, setWorkOrderNumber] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [rev, setRev] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWorkOrderNumber(initialWorkOrder.trim());
    setCustomerName("");
    setPartNumber("");
    setRev("");
    setNote("");
    setError(null);
  }, [open, initialWorkOrder]);

  const trimmedWo = workOrderNumber.trim();
  const woValid = WO_RE.test(trimmedWo);

  const submit = async () => {
    if (!woValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/custom-work-orders", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderNumber: trimmedWo, customerName, partNumber, rev, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      onCreated(body as CustomWorkOrder);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-lg" data-testid="dialog-custom-work-order">
        <DialogHeader>
          <DialogTitle>Create custom work order</DialogTitle>
          <DialogDescription>
            For jobs that aren't in Sage (samples, RMAs, internal work). Everyone will see it in the Work Order
            list. Customer and Part # are optional — without a customer, files go to the "No Customer" folder.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="custom-wo-number">
              Work Order # <span className="text-destructive">*</span>
            </Label>
            <Input
              id="custom-wo-number"
              value={workOrderNumber}
              onChange={(e) => setWorkOrderNumber(e.target.value)}
              maxLength={40}
              autoComplete="off"
              className="min-h-12 font-mono text-base"
              data-testid="input-custom-wo-number"
              autoFocus
            />
            {trimmedWo && !woValid ? (
              <p className="text-sm text-destructive">
                Use letters, numbers, spaces, dot, dash or underscore (max 40).
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-wo-customer">
              Customer <span className="text-sm font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="custom-wo-customer"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              maxLength={200}
              autoComplete="off"
              className="min-h-12 text-base"
              data-testid="input-custom-wo-customer"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="custom-wo-part">
                Part # <span className="text-sm font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="custom-wo-part"
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                maxLength={100}
                autoComplete="off"
                className="min-h-12 font-mono text-base"
                data-testid="input-custom-wo-part"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-wo-rev">Rev.</Label>
              <Input
                id="custom-wo-rev"
                value={rev}
                onChange={(e) => setRev(e.target.value)}
                maxLength={20}
                autoComplete="off"
                className="min-h-12 text-base"
                data-testid="input-custom-wo-rev"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-wo-note">
              Note <span className="text-sm font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="custom-wo-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              autoComplete="off"
              placeholder="e.g. Engineering sample for…"
              className="min-h-12 text-base"
              data-testid="input-custom-wo-note"
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" data-testid="text-custom-wo-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!woValid || saving} data-testid="button-create-custom-wo">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create work order
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
