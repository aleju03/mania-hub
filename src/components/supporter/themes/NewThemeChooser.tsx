import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

import { Popover } from "./EditorControls";
import { LayerIcon } from "./LayerIcons";

/* The choice a new theme starts with: built from layers (no code) or written
   as code. Shared by the themes page's New theme button and the workshop's
   Make a theme tile. */
export function NewThemeChooser({ trigger, align = "left" }: { trigger: (toggle: () => void) => ReactNode; align?: "left" | "right" }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const choices = [
    { mode: "layers" as const, title: t`With layers`, blurb: t`Stack a background, your pictures, particles, fog and light. No code.`, icon: <LayerIcon kind="image" className="h-6 w-6" /> },
    { mode: "code" as const, title: t`With code`, blurb: t`Write the shader yourself, start from a built-in theme, or paste a Shadertoy one.`, icon: <span className="font-mono text-[15px] font-bold">{"{ }"}</span> },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen} align={align} className="w-[min(320px,calc(100vw-2rem))]" trigger={trigger(() => setOpen((value) => !value))}>
      <div className="grid gap-1">
        {choices.map((choice) => (
          <Link
            key={choice.mode}
            to="/workshop/themes/$themeId"
            params={{ themeId: "new" }}
            search={{ mode: choice.mode }}
            onClick={() => setOpen(false)}
            className="flex items-start gap-3 rounded-lg p-2.5 transition-colors hover:bg-osu-b3"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-osu-b6 text-osu-pink-light">{choice.icon}</span>
            <span>
              <span className="block text-[13px] font-semibold text-white">{choice.title}</span>
              <span className="block text-[11.5px] text-osu-f1">{choice.blurb}</span>
            </span>
          </Link>
        ))}
      </div>
    </Popover>
  );
}
