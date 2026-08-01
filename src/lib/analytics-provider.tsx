import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSelectedCountry } from "../store";
import { useAuth } from "./auth-context";
import { capturePageview, registerSuperProperties } from "./analytics";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchKey = useRouterState({
    select: (s) => JSON.stringify(s.location.search ?? {}),
  });
  const selectedCountry = useSelectedCountry();
  const viewer = useAuth().viewer;
  const viewerUsername = viewer?.username ?? null;
  const viewerId = viewer?.id ?? null;

  useEffect(() => {
    registerSuperProperties({ selected_country: selectedCountry });
  }, [selectedCountry]);

  // Attribute events to the signed-in osu! account so the admin activity feed
  // can name who did what; anonymous visitors stay anonymous. Registered before
  // the pageview effect so the first captured pageview already carries it, and
  // set to null on logout so a stale identity never lingers on the session.
  useEffect(() => {
    registerSuperProperties({ viewer_username: viewerUsername, viewer_id: viewerId });
  }, [viewerUsername, viewerId]);

  useEffect(() => {
    capturePageview(pathname);
  }, [pathname, searchKey]);

  return <>{children}</>;
}
