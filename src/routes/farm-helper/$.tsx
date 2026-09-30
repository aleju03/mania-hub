import { createFileRoute } from "@tanstack/react-router";

// Matches /farm-helper/map/<id> and friends so the parent's redirect sees them.
export const Route = createFileRoute("/farm-helper/$")({});
