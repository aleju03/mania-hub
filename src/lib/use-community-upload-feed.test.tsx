// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommunityUploadsPage } from "./uploaded-replay-feed";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";
const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("./uploaded-replay-community", () => ({ getCommunityUploadsPage: fetchPage }));
import { useCommunityUploadFeed } from "./use-community-upload-feed";

function page(ids: string[], nextCursor: string | null = null): CommunityUploadsPage {
  return { uploads: ids.map((id) => ({ id } as CommunityUploadEntry)), total: 100, nextCursor, indexing: false };
}
const query = { q: "", keys: "all", sort: "newest" } as const;

describe("community feed requests", () => {
  it("prefetches once, deduplicates appends, and restores loaded cards on return", async () => {
    fetchPage.mockResolvedValueOnce(page(["a", "b"], "next")).mockResolvedValueOnce(page(["b", "c"]));
    const first = renderHook(() => useCommunityUploadFeed({ ...query, q: "restore" }));
    await waitFor(() => expect(first.result.current.uploads).toHaveLength(2));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    act(() => { first.result.current.loadMore(); first.result.current.loadMore(); });
    await waitFor(() => expect(first.result.current.uploads.map((entry) => entry.id)).toEqual(["a", "b", "c"]));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    first.unmount();
    const second = renderHook(() => useCommunityUploadFeed({ ...query, q: "restore" }));
    expect(second.result.current.uploads).toHaveLength(3);
    expect(second.result.current.loading).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("ignores an old search response after filters change", async () => {
    let resolve!: (result: CommunityUploadsPage) => void;
    fetchPage.mockReturnValueOnce(new Promise<CommunityUploadsPage>((r) => { resolve = r; })).mockResolvedValueOnce(page(["new"]));
    const hook = renderHook(({ q }) => useCommunityUploadFeed({ ...query, q }), { initialProps: { q: "old-search" } });
    hook.rerender({ q: "new-search" });
    await waitFor(() => expect(hook.result.current.uploads[0]?.id).toBe("new"));
    await act(async () => { resolve(page(["old"])); });
    expect(hook.result.current.uploads[0]?.id).toBe("new");
    hook.unmount();
  });

  it("keeps loaded cards after a next-page failure and retries that page", async () => {
    fetchPage.mockResolvedValueOnce(page(["kept"], "retry-next"))
      .mockRejectedValueOnce(new Error("prefetch failed"))
      .mockRejectedValueOnce(new Error("page failed"))
      .mockResolvedValueOnce(page(["recovered"]));
    const hook = renderHook(() => useCommunityUploadFeed({ ...query, q: "retry" }));
    await waitFor(() => expect(hook.result.current.uploads).toHaveLength(1));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    expect(hook.result.current.uploads[0].id).toBe("kept");
    act(() => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.uploads.map((entry) => entry.id)).toEqual(["kept", "recovered"]));
    hook.unmount();
  });

  it("allows paging during catalog hydration and refreshes all visible results", async () => {
    const ids = Array.from({ length: 48 }, (_, index) => `warming-${index}`);
    fetchPage.mockResolvedValueOnce({ ...page(ids.slice(0, 24), "warming-next"), indexing: true })
      .mockResolvedValueOnce({ ...page(ids.slice(24)), indexing: true })
      .mockResolvedValueOnce(page(["new-match", ...ids.slice(0, 47)]));
    const hook = renderHook(() => useCommunityUploadFeed({ ...query, q: "warming" }));
    await waitFor(() => expect(hook.result.current.uploads).toHaveLength(24));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.uploads).toHaveLength(48));
    await waitFor(() => expect(hook.result.current.indexing).toBe(false), { timeout: 3000 });
    expect(fetchPage).toHaveBeenLastCalledWith({ data: expect.objectContaining({ limit: 48 }) });
    expect(hook.result.current.uploads[0].id).toBe("new-match");
    expect(hook.result.current.uploads).toHaveLength(48);
    hook.unmount();
  });
});
