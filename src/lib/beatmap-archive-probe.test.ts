import { describe, expect, it } from "vitest";
import {
  hasZipArchiveSignature,
  responseStartsWithZipArchive,
} from "./beatmap-archive-probe";

describe("hasZipArchiveSignature", () => {
  it("accepts the standard ZIP signatures", () => {
    expect(hasZipArchiveSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(hasZipArchiveSignature(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(hasZipArchiveSignature(new Uint8Array([0x50, 0x4b, 0x07, 0x08]))).toBe(true);
  });

  it("rejects JSON and truncated prefixes", () => {
    expect(hasZipArchiveSignature(new TextEncoder().encode('{"success":true}'))).toBe(false);
    expect(hasZipArchiveSignature(new Uint8Array([0x50, 0x4b, 0x03]))).toBe(false);
  });
});

describe("responseStartsWithZipArchive", () => {
  it("accepts archive bytes even when the response arrives in small chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50]));
        controller.enqueue(new Uint8Array([0x4b, 0x03]));
        controller.enqueue(new Uint8Array([0x04, 0x14, 0x00]));
        controller.close();
      },
    });

    await expect(responseStartsWithZipArchive(new Response(body))).resolves.toBe(true);
  });

  it("rejects resolver JSON mislabeled as an osu! archive", async () => {
    const response = new Response(
      JSON.stringify({
        success: true,
        download_url: "https://mirror.example/api/download/400078",
      }),
      {
        headers: {
          "Content-Type": "application/x-osu-beatmap-archive",
          "Content-Disposition": 'attachment; filename="400078 Example.osz"',
        },
      },
    );

    await expect(responseStartsWithZipArchive(response)).resolves.toBe(false);
  });
});
