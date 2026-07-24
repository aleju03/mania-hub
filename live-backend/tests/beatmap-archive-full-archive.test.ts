import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getFullArchiveForTest,
  __getFullArchiveStateForTest,
  __resetArchiveSourceOrderForTest,
} from "../src/audio/beatmap-archive.js";

const MAX_BYTES = 4096;

// Smallest thing that passes the "looks like a zip" check; these tests never
// parse the archive, they only observe how it is fetched.
function zipResponse(): Response {
  const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  return new Response(body, { headers: { "content-length": String(body.length) } });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("full archive downloads", () => {
  beforeEach(() => {
    __resetArchiveSourceOrderForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one download between concurrent extractions of the same set", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = __getFullArchiveForTest("2136400", MAX_BYTES);
    const second = __getFullArchiveForTest("2136400", MAX_BYTES);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(__getFullArchiveStateForTest().inFlight).toBe(1);

    pending[0](zipResponse());
    const [a, b] = await Promise.all([first, second]);

    expect(a.buffer).toBe(b.buffer);
    expect(__getFullArchiveStateForTest()).toEqual({ inFlight: 0, active: 0, waiting: 0 });
  });

  it("caps how many full archives download at once", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    }));
    vi.stubGlobal("fetch", fetchMock);

    const downloads = ["1", "2", "3"].map((id) => __getFullArchiveForTest(id, MAX_BYTES));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(__getFullArchiveStateForTest().waiting).toBe(1);

    pending[0](zipResponse());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    pending[1](zipResponse());
    pending[2](zipResponse());
    await Promise.all(downloads);

    expect(__getFullArchiveStateForTest()).toEqual({ inFlight: 0, active: 0, waiting: 0 });
  });

  it("releases the slot and the in-flight entry when every mirror fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));

    await expect(__getFullArchiveForTest("999", MAX_BYTES)).rejects.toThrow(/no mirror served the archive/);
    expect(__getFullArchiveStateForTest()).toEqual({ inFlight: 0, active: 0, waiting: 0 });
  });
});
