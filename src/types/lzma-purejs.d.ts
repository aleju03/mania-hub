declare module "lzma-purejs" {
  export function compressFile(input: Uint8Array): Uint8Array;
  export function decompressFile(input: Uint8Array): Uint8Array;
  const lzma: { compressFile: typeof compressFile; decompressFile: typeof decompressFile };
  export default lzma;
}
