import { useEffect, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { fetchSimilarSkins, type SimilarSkin } from "../../lib/skins";
import { SkinCard } from "./SkinCard";

// The strip of lookalikes at the foot of a skin's page, answered for the
// keymode the viewer has open above: skins change note shape across their
// range (bars at 7K, arrows at 4K is a real skin in the catalog), so "what
// looks like this" only means something once you say which playfield. Picking
// a different keymode in the gallery asks the question again, and the cards
// front that same keymode, which is what makes the row a comparison.
//
// Fetched after mount so the page never waits on it, and absent entirely
// (heading included) until real cards exist to stand under it. The previous
// answer stays on screen while the next one loads, so stepping through the
// keymodes does not flash the section in and out.
export function SimilarSkins({ skinRef, keys }: { skinRef: string; keys?: number | null }) {
  const [skins, setSkins] = useState<SimilarSkin[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchSimilarSkins(skinRef, keys).then((result) => {
      if (!cancelled) setSkins(result);
    });
    return () => {
      cancelled = true;
    };
  }, [skinRef, keys]);

  if (skins.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-bold text-white"><Trans>Similar skins</Trans></h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {skins.map((skin) => (
          <SkinCard key={skin.id} skin={skin} previewKeys={skin.matchKeys ?? keys ?? undefined} />
        ))}
      </div>
    </section>
  );
}
