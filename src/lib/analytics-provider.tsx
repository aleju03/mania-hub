import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSelectedCountry } from "../store";
import { capturePageview, registerSuperProperties } from "./analytics";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchKey = useRouterState({
    select: (s) => JSON.stringify(s.location.search ?? {}),
  });
  const selectedCountry = useSelectedCountry();

  useEffect(() => {
    registerSuperProperties({ selected_country: selectedCountry });
  }, [selectedCountry]);

  useEffect(() => {
    capturePageview(pathname);
  }, [pathname, searchKey]);

  return <>{children}</>;
}
