import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSelectedCountry } from "../store";
import { capturePageview, registerSuperProperties } from "./posthog";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
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
