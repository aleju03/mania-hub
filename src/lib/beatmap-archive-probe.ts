const ZIP_PREFIX_LENGTH = 4;

export function hasZipArchiveSignature(prefix: Uint8Array): boolean {
  if (prefix.length < ZIP_PREFIX_LENGTH) return false;
  if (prefix[0] !== 0x50 || prefix[1] !== 0x4b) return false;

  const marker = (prefix[2] << 8) | prefix[3];
  return marker === 0x0304 || marker === 0x0506 || marker === 0x0708;
}

// Mirror responses cannot be trusted by headers alone. Some resolver APIs
// label a small JSON handoff as an osu! archive, including an .osz filename.
// Read only enough of the response stream to verify that it is really a ZIP,
// then cancel the probe before the archive body flows through our server.
export async function responseStartsWithZipArchive(response: Response): Promise<boolean> {
  if (!response.body) return false;

  const reader = response.body.getReader();
  const prefix = new Uint8Array(ZIP_PREFIX_LENGTH);
  let prefixLength = 0;

  try {
    while (prefixLength < ZIP_PREFIX_LENGTH) {
      const { done, value } = await reader.read();
      if (done) break;

      const copyLength = Math.min(value.byteLength, ZIP_PREFIX_LENGTH - prefixLength);
      prefix.set(value.subarray(0, copyLength), prefixLength);
      prefixLength += copyLength;
    }

    return prefixLength === ZIP_PREFIX_LENGTH && hasZipArchiveSignature(prefix);
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
