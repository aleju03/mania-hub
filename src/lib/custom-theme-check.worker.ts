import { compileCustomThemeSource, customThemeLineProgram } from "#custom-themes/source";

/* The theme checker off the editor's main thread: a macro that expands for
   ever would otherwise freeze the tab while the author types. With a passing
   check comes the author's code as the driver should read it for errors
   (customThemeLineProgram). */
self.onmessage = (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  const result = compileCustomThemeSource(source);
  self.postMessage({ id, result, lineProgram: result.ok ? customThemeLineProgram(source, result.format) : null });
};
