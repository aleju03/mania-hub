import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(), writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), mkdir: vi.fn(async () => {}),
  list: vi.fn(), read: vi.fn(), describe: vi.fn(), owners: vi.fn(), assets: vi.fn(), waitUntil: vi.fn(), needsStars: vi.fn((_upload: { starRatingAtRate?: number }) => false),
}));
vi.mock("node:fs/promises", () => mocks);
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("./uploaded-replay-store", () => ({ listRecentUploadedReplays: mocks.list, uploadedReplaysUseR2: () => false, normalizeUploadedReplayId: (id: string) => id }));
vi.mock("./uploaded-replay-describe", () => ({ DESCRIPTION_VERSION: 3, readUploadedReplayDescription: mocks.read,
  describeUploadedReplayById: mocks.describe, needsStarRatingAtRate: mocks.needsStars }));
vi.mock("./uploaded-replay-index", () => ({ fetchUploadedReplayIndexRows: mocks.owners }));
vi.mock("./community-beatmap-store", () => ({ getCommunityBeatmapAssets: mocks.assets }));

const upload = { id: "abcdefghijklmnop", playerName: "Player", mods: [], keyCount: 4, accuracy: .99, uploadedAt: 123,
  beatmap: { title: "Map" }, version: 3, uploadedBy: null } as unknown as CommunityUploadEntry;
const query = { q: "", keys: "all", grade: "all", starMin: 0, starMax: 0, sort: "newest" } as const;
const finish = () => mocks.waitUntil.mock.calls.at(-1)?.[0] as Promise<void>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.readFile.mockRejectedValue(new Error("ENOENT"));
  mocks.list.mockResolvedValue([{ id: upload.id, uploadedAt: upload.uploadedAt }]);
  mocks.read.mockResolvedValue(upload);
  mocks.describe.mockResolvedValue(upload);
  mocks.owners.mockResolvedValue(new Map());
  mocks.assets.mockResolvedValue({ background: false, audio: false });
  mocks.needsStars.mockReturnValue(false);
});

describe("community replay catalog", () => {
  it("returns immediately while summaries load, then reuses metadata across pages and filters", async () => {
    const slow = deferred<CommunityUploadEntry>();
    mocks.read.mockReturnValue(slow.promise);
    const server = await import("./uploaded-replay-community-server");
    expect(await server.getUploadsFeed(query)).toMatchObject({ uploads: [], indexing: true });
    slow.resolve(upload);
    await finish();
    expect((await server.getUploadsFeed(query)).uploads).toHaveLength(1);
    expect((await server.getUploadsFeed({ ...query, q: "map" })).uploads).toHaveLength(1);
    await server.getUploadsSlice(0, 9);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.describe).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalled();
  });

  it("serves the persisted catalog on restart, even when storage listing fails", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, entries: [{ upload, checkedAt: Date.now() }] }));
    mocks.list.mockRejectedValue(new Error("storage offline"));
    const server = await import("./uploaded-replay-community-server");
    expect((await server.getUploadsFeed(query)).uploads).toHaveLength(1);
    await finish();
    expect((await server.getUploadsFeed(query)).uploads).toHaveLength(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("does not let a slow replay repair hold up already described cards", async () => {
    const slow = deferred<CommunityUploadEntry>();
    const second = { ...upload, id: "ponmlkjihgfedcba" };
    mocks.list.mockResolvedValue([upload, second]);
    mocks.read.mockImplementation(async (id) => id === upload.id ? upload : null);
    mocks.describe.mockReturnValue(slow.promise);
    const server = await import("./uploaded-replay-community-server");
    await server.getUploadsFeed(query);
    await vi.waitFor(() => expect(mocks.describe).toHaveBeenCalled());
    expect(await server.getUploadsFeed(query)).toMatchObject({ uploads: [expect.objectContaining({ id: upload.id })], indexing: true });
    slow.resolve(second);
    await finish();
    expect(await server.getUploadsFeed(query)).toMatchObject({ total: 2, indexing: false });
  });

  it("re-describes a card still missing the star rating its play ran at", async () => {
    const rated = { ...upload, starRatingAtRate: 6.68 };
    mocks.needsStars.mockImplementation((entry) => entry.starRatingAtRate === undefined);
    mocks.describe.mockResolvedValue(rated);
    const server = await import("./uploaded-replay-community-server");
    await server.getUploadsFeed(query);
    await finish();
    expect(mocks.describe).toHaveBeenCalledWith(upload.id);
    expect((await server.getUploadsFeed(query)).uploads[0]).toMatchObject({ starRatingAtRate: 6.68 });
  });

  it("does not resurrect an upload deleted during hydration", async () => {
    const slow = deferred<CommunityUploadEntry>();
    mocks.read.mockReturnValue(slow.promise);
    const server = await import("./uploaded-replay-community-server");
    await server.getUploadsFeed(query);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled());
    server.invalidateCommunityUploads(upload.id);
    slow.resolve(upload);
    await finish();
    expect((await server.getUploadsFeed(query)).uploads).toEqual([]);
    await finish();
    expect((await server.getUploadsFeed(query)).uploads).toEqual([]);
  });
});
