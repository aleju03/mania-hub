// The chart-analysis pattern vocabulary as presentation: label, localized
// label and color per tag id. Extracted from maps/SearchCard so a surface
// that only needs to name a pattern (the my-stats play diet) doesn't pull the
// map card's audio-preview dependencies in with it; the card re-exports these
// so its own callers are unchanged.

import { useCallback } from "react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

export const PATTERN_LABEL: Record<string, string> = {
  jack: "Jack",
  stream: "Stream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  stamina: "Stamina",
  chordjack: "Chordjack",
  tech: "Tech",
  ln: "LN",
  // subfamilies from the pattern analyzer (filterable via detected tags)
  speedjack: "Speedjack",
  handjack: "Handjack",
  dumpstream: "Dumpstream",
  quadstream: "Quadstream",
  chordstream: "Chordstream",
  delay: "Delay",
  bracket: "Bracket",
  lngeneral: "LN General",
  lnrelease: "LN Release",
  lninverse: "LN Inverse",
  lntech: "LN Tech",
};

// Same table as PATTERN_LABEL, in descriptor form: `PATTERN_LABEL` stays the
// English one for membership checks and non-React callers, `PATTERN_LABEL_MSG`
// is what the DOM renders through an i18n instance.
export const PATTERN_LABEL_MSG: Record<string, MessageDescriptor> = {
  jack: msg`Jack`,
  stream: msg`Stream`,
  jumpstream: msg`Jumpstream`,
  handstream: msg`Handstream`,
  stamina: msg`Stamina`,
  chordjack: msg`Chordjack`,
  tech: msg`Tech`,
  ln: msg`LN`,
  speedjack: msg`Speedjack`,
  handjack: msg`Handjack`,
  dumpstream: msg`Dumpstream`,
  quadstream: msg`Quadstream`,
  chordstream: msg`Chordstream`,
  delay: msg`Delay`,
  bracket: msg`Bracket`,
  lngeneral: msg`LN General`,
  lnrelease: msg`LN Release`,
  lninverse: msg`LN Inverse`,
  lntech: msg`LN Tech`,
};

export const PATTERN_COLOR: Record<string, string> = {
  jack: "#ec6a9c",
  stream: "#5ab2f2",
  jumpstream: "#46c7b8",
  handstream: "#f3c24a",
  stamina: "#ef9a4d",
  chordjack: "#b483f0",
  tech: "#83cf6b",
  ln: "#f07474",
  // subfamilies inherit their family's color
  speedjack: "#ec6a9c",
  handjack: "#ec6a9c",
  quadstream: "#ec6a9c",
  dumpstream: "#5ab2f2",
  chordstream: "#5ab2f2",
  delay: "#5ab2f2",
  bracket: "#5ab2f2",
  lngeneral: "#f07474",
  lnrelease: "#f07474",
  lninverse: "#f07474",
  lntech: "#f07474",
};

export function patternLabel(pattern: string): string {
  return PATTERN_LABEL[pattern] ?? pattern;
}

// Localized pattern label for DOM consumers. Unknown ids (an older payload, a
// shared URL) fall through to the raw id, exactly like patternLabel().
export function usePatternLabel(): (pattern: string) => string {
  const { i18n } = useLingui();
  return useCallback(
    (pattern: string) => {
      const descriptor = PATTERN_LABEL_MSG[pattern];
      return descriptor ? i18n._(descriptor) : pattern;
    },
    [i18n],
  );
}
