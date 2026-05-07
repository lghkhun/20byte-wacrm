import { ReportWorkspace } from "@/components/report/ReportWorkspace";

export default async function ReportPage({
  searchParams
}: {
  searchParams?: Promise<{ tab?: string; from?: string; to?: string }>;
}) {
  const resolved = searchParams ? await searchParams : undefined;
  return (
    <ReportWorkspace
      initialTab={resolved?.tab}
      initialFrom={resolved?.from}
      initialTo={resolved?.to}
    />
  );
}
