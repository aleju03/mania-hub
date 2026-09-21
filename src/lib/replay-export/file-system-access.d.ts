// `showSaveFilePicker` is not in TypeScript's DOM library yet, although
// `FileSystemFileHandle` and `FileSystemWritableFileStream` are. Declare just
// the entry point the exporter uses.

interface SaveFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  id?: string;
  startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
  types?: SaveFilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}

interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}
