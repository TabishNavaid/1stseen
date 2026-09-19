import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const styles: Record<string, { label: string; icon: IconName; className: string }> = {
  official: { label: "Official", icon: "building-2", className: "source-official" },
  archive: { label: "Archive", icon: "history", className: "source-archive" },
  signal: { label: "Signal", icon: "database", className: "source-signal" },
  community: { label: "Community", icon: "message-circle", className: "source-community" },
};

export function SourceBadge({ kind, label }: { kind: "official" | "archive" | "signal" | "community"; label?: string }) {
  const item = styles[kind];
  return <span className={cn("inline-flex items-center gap-1 rounded-chip border px-2 py-1 text-micro font-semibold", item.className)}><Icon name={item.icon} size={11} />{label ?? item.label}</span>;
}
