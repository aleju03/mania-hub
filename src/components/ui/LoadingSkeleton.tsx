export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`skeleton-pulse rounded ${className}`} />
  );
}

export function ScoreRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded bg-osu-b4/50">
      <Skeleton className="w-7 h-7 rounded-full" />
      <Skeleton className="w-7 h-7 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-3 w-32" />
      </div>
      <Skeleton className="h-4 w-16" />
    </div>
  );
}

export function PlayerCardSkeleton() {
  return (
    <div className="bg-osu-b4 rounded-xl p-5 space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="w-14 h-14 rounded-full" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
      </div>
    </div>
  );
}

export function RankingRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3">
      <Skeleton className="w-8 h-4" />
      <Skeleton className="w-8 h-8 rounded-full" />
      <Skeleton className="h-4 w-28 flex-1" />
      <Skeleton className="h-4 w-12" />
      <Skeleton className="h-4 w-16" />
    </div>
  );
}
