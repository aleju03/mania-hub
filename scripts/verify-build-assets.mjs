import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const publicDir = path.join(repoRoot, ".output", "public");

const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs"]);
const existenceCache = new Map();
const missing = [];
const checkedRefs = new Set();

async function exists(filePath) {
  if (!existenceCache.has(filePath)) {
    existenceCache.set(
      filePath,
      access(filePath).then(
        () => true,
        () => false,
      ),
    );
  }
  return existenceCache.get(filePath);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(filePath));
    } else if (textExtensions.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }

  return files;
}

function stripSuffix(ref) {
  return ref.split(/[?#]/, 1)[0];
}

function resolveLocalRef(sourceFile, ref) {
  const cleanRef = stripSuffix(ref);
  if (!cleanRef || cleanRef.includes("${")) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(cleanRef)) return null;
  if (/^(?:data|blob|mailto):/i.test(cleanRef)) return null;

  if (cleanRef.startsWith("/")) {
    return path.join(publicDir, cleanRef.slice(1));
  }

  if (cleanRef.startsWith("assets/")) {
    return path.join(publicDir, cleanRef);
  }

  if (cleanRef.startsWith("./") || cleanRef.startsWith("../")) {
    return path.resolve(path.dirname(sourceFile), cleanRef);
  }

  return null;
}

async function checkRef(sourceFile, ref) {
  const target = resolveLocalRef(sourceFile, ref);
  if (!target || !target.startsWith(publicDir)) return;

  const key = `${sourceFile}:${ref}`;
  if (checkedRefs.has(key)) return;
  checkedRefs.add(key);

  if (!await exists(target)) {
    missing.push({
      ref,
      source: path.relative(repoRoot, sourceFile),
      target: path.relative(repoRoot, target),
    });
  }
}

async function scanJs(sourceFile, text) {
  const staticImportRegex = /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicImportRegex = /import\(\s*["']([^"']+)["']\s*\)/g;
  const viteAssetRegex = /["'](\/?assets\/[^"']+)["']/g;

  for (const regex of [staticImportRegex, dynamicImportRegex, viteAssetRegex]) {
    for (const match of text.matchAll(regex)) {
      await checkRef(sourceFile, match[1]);
    }
  }
}

async function scanCss(sourceFile, text) {
  const urlRegex = /url\(\s*["']?([^"')]+)["']?\s*\)/g;

  for (const match of text.matchAll(urlRegex)) {
    await checkRef(sourceFile, match[1]);
  }
}

async function scanHtmlLike(sourceFile, text) {
  const attrRegex = /\b(?:href|src)=["']([^"']+)["']/g;

  for (const match of text.matchAll(attrRegex)) {
    await checkRef(sourceFile, match[1]);
  }
}

async function main() {
  if (!await exists(publicDir)) {
    throw new Error(`Build output not found at ${path.relative(repoRoot, publicDir)}`);
  }

  const files = await walk(publicDir);

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const ext = path.extname(file);

    if (ext === ".js" || ext === ".mjs") {
      await scanJs(file, text);
    }
    if (ext === ".css") {
      await scanCss(file, text);
    }
    if (ext === ".html" || ext === ".json") {
      await scanHtmlLike(file, text);
    }
  }

  if (missing.length > 0) {
    console.error("Missing emitted asset references:");
    for (const item of missing.slice(0, 50)) {
      console.error(`- ${item.source} -> ${item.ref} (${item.target})`);
    }
    if (missing.length > 50) {
      console.error(`...and ${missing.length - 50} more`);
    }
    process.exit(1);
  }

  console.log(`Verified ${checkedRefs.size} emitted asset references across ${files.length} files.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
