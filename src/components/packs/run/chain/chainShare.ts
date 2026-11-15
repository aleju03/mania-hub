import { shareOwnChainRun, type ChainRunMode } from "#/lib/chain-run";

/* Shares a finished run as a link: its own page, which a chat unfurls into
   the run's card. Phones get the share sheet; elsewhere the link is copied.
   A guest's run has no page, so theirs shares the game. "shared", "copied"
   or null (cancelled, or nothing worked). */
export async function shareChainRunLink(mode: ChainRunMode, caption: (link: string) => string): Promise<"shared" | "copied" | null> {
  const made = await shareOwnChainRun({ data: mode }).catch(() => null);
  const link = made ? `${window.location.origin}/packs/overjoy/${made.id}` : `${window.location.origin}/packs?view=run`;
  const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  if (touch && navigator.share) {
    try {
      await navigator.share({ url: link, text: caption(link) });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    return "copied";
  } catch {
    window.prompt("", link);
    return null;
  }
}
