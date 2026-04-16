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

export function TrackerRowSkeleton() {
  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden">
      <div className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4">
        <Skeleton className="w-8 h-8 rounded" />
        <Skeleton className="w-9 h-9 rounded-full" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-10 sm:hidden" />
          </div>
          <div className="flex items-center justify-between sm:justify-start gap-2 mt-1">
            <div className="flex items-center gap-2 min-w-0 flex-1 sm:flex-initial">
              <Skeleton className="h-3 w-40 sm:w-56 max-w-full" />
              <Skeleton className="h-3 w-14 hidden sm:block" />
            </div>
            <Skeleton className="h-3.5 w-6 rounded flex-shrink-0" />
          </div>
          <div className="flex items-center justify-between gap-2 mt-1.5 sm:hidden">
            <div className="flex items-center gap-1">
              <Skeleton className="h-4 w-6 rounded" />
              <Skeleton className="h-4 w-6 rounded" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3.5 w-14" />
            </div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-0.5">
            <Skeleton className="h-4 w-6 rounded" />
            <Skeleton className="h-4 w-6 rounded" />
          </div>
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-16 rounded" />
          <Skeleton className="h-3 w-10" />
        </div>
      </div>
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
