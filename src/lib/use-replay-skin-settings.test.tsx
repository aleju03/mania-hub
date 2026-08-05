// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  REPLAY_SKIN_STORAGE_KEY,
  normalizeReplaySkinSettings,
  readReplaySkinSettings,
  writeReplaySkinSettings,
} from "./replay-skin";
import { useReplaySkinSettings } from "./use-replay-skin-settings";

// Mirrors the quota-pressure suite in replay-skin.test.ts, but through a real
// listener: proving the event carries the full settings is not enough if the
// consumers throw the detail away and re-read the stripped copy.
const LIMIT = 5000;
const ART = `data:image/png;base64,${"A".repeat(6000)}`;

const settingsWithArt = () => normalizeReplaySkinSettings({
  ...DEFAULT_REPLAY_SKIN_SETTINGS,
  tapColor: "#101820",
  keymodeProfiles: {
    "4": {
      columnWidth: 91,
      assets: { columns: [{ lnBody: { name: "LN_Body.png", src: ART, width: 128, height: 4096 } }] },
    },
  },
});

describe("useReplaySkinSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (value.length > LIMIT) {
        const error = new Error(`Setting the value of '${key}' exceeded the quota.`);
        error.name = "QuotaExceededError";
        throw error;
      }
      original.call(this, key, value);
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps drawing the dispatched art when only the stripped copy fit localStorage", async () => {
    const { result } = renderHook(() => useReplaySkinSettings());
    await act(async () => {});

    await act(async () => {
      writeReplaySkinSettings(settingsWithArt());
    });

    // The stored copy lost its art to the quota...
    expect(readReplaySkinSettings().keymodeProfiles["4"].assets.columns[0]?.lnBody).toBeUndefined();
    // ...but the hook drew from the event's full settings, not a re-read.
    expect(result.current.tapColor).toBe("#101820");
    expect(result.current.keymodeProfiles["4"].columnWidth).toBe(91);
    expect(result.current.keymodeProfiles["4"].assets.columns[0]?.lnBody?.src).toBe(ART);
  });

  it("still re-reads storage on refreshes that carry no settings", async () => {
    const { result } = renderHook(() => useReplaySkinSettings());
    await act(async () => {});

    // Another tab's write arrives with no detail, only the storage behind it.
    window.localStorage.setItem(REPLAY_SKIN_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      tapColor: "#0000ff",
    }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current.tapColor).toBe("#0000ff");
  });
});
