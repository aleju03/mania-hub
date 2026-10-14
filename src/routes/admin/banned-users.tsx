import { createFileRoute, redirect } from "@tanstack/react-router";

// Now the first tab of /admin/players; the list's filter and page carry over.
export const Route = createFileRoute("/admin/banned-users")({
  validateSearch: (search: Record<string, unknown>): { filter?: string; page?: number } => ({
    filter: typeof search.filter === "string" ? search.filter : undefined,
    page: Number.isInteger(Number(search.page)) ? Number(search.page) : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/admin/players",
      search: {
        filter: search.filter === "restricted" || search.filter === "all" ? search.filter : undefined,
        page: search.page != null && search.page > 1 ? search.page : undefined,
      },
      replace: true,
    });
  },
});
