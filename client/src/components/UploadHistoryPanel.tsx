import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";

type UploadHistoryItem = {
  id: string;
  uploadedAt: string;
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  customerName: string;
  folderPath: string;
  fileName: string | null;
  webUrl: string | null;
  dept: string | null;
  userId: string;
  userEmail: string;
  userName: string;
};

async function fetchHistory(scope: "mine" | "all"): Promise<UploadHistoryItem[]> {
  const res = await fetch(`/api/upload-history?scope=${scope}`, {
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to load history");
  }
  return (data.items || []) as UploadHistoryItem[];
}

function formatDate(iso: string): string {
  try {
    return format(new Date(iso), "MMM d, yyyy h:mm a");
  } catch {
    return iso;
  }
}

function HistoryTable({
  rows,
  showUploader,
  emptyMessage,
}: {
  rows: UploadHistoryItem[];
  showUploader: boolean;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          {showUploader ? <TableHead>Uploaded By</TableHead> : null}
          <TableHead>Work Order</TableHead>
          <TableHead>Part Number</TableHead>
          <TableHead>Rev</TableHead>
          <TableHead>Customer Name</TableHead>
          <TableHead>Folder Path</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-nowrap">{formatDate(row.uploadedAt)}</TableCell>
            {showUploader ? (
              <TableCell className="max-w-[10rem] truncate" title={row.userEmail}>
                {row.userName || row.userEmail}
              </TableCell>
            ) : null}
            <TableCell className="font-mono">{row.workOrderNumber}</TableCell>
            <TableCell>{row.partNumber || "—"}</TableCell>
            <TableCell>{row.rev || "—"}</TableCell>
            <TableCell className="max-w-[12rem] truncate" title={row.customerName}>
              {row.customerName}
            </TableCell>
            <TableCell className="max-w-[16rem] truncate font-mono text-xs" title={row.folderPath}>
              {row.webUrl ? (
                <a
                  href={row.webUrl.replace(/\/[^/]+$/, "")}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {row.folderPath}
                </a>
              ) : (
                row.folderPath
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function UploadHistoryPanel() {
  const auth = useAuth();
  const userName =
    auth.status === "authenticated" ? auth.user.name || auth.user.email : "you";

  const mine = useQuery({
    queryKey: ["upload-history", "mine"],
    queryFn: () => fetchHistory("mine"),
  });

  const all = useQuery({
    queryKey: ["upload-history", "all"],
    queryFn: () => fetchHistory("all"),
  });

  return (
    <Card className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground sm:text-xl">Upload History</h2>
        <p className="text-sm text-muted-foreground">
          Track images uploaded to SharePoint by you and by everyone.
        </p>
      </div>

      <Tabs defaultValue="mine">
        <TabsList className="mb-4 grid w-full grid-cols-2 sm:inline-flex sm:w-auto">
          <TabsTrigger value="mine" data-testid="tab-history-mine">
            My uploads
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-history-all">
            Everyone
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mine">
          {mine.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : mine.isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              {(mine.error as Error).message}
            </p>
          ) : (
            <HistoryTable
              rows={mine.data || []}
              showUploader={false}
              emptyMessage={`No uploads yet for ${userName}.`}
            />
          )}
        </TabsContent>

        <TabsContent value="all">
          {all.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : all.isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              {(all.error as Error).message}
            </p>
          ) : (
            <HistoryTable
              rows={all.data || []}
              showUploader
              emptyMessage="No uploads recorded yet."
            />
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}
