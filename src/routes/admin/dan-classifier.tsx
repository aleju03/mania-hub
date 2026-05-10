import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import JSZip from "jszip";
import { Check, ClipboardList, Copy, FileSpreadsheet, RotateCcw, Search, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseManiaBeatmap } from "../../lib/beatmap-parser";
import { filterBeatmapSearchResults } from "../../lib/beatmap-search";
import { estimateDan } from "../../lib/dan-estimator";
import { estimateDanielDan } from "../../lib/daniel-estimator";
import { getBeatmapFile, getBeatmapset, getBeatmapsetForBeatmap, getUser, getUserScoresBestWindow, searchBeatmaps, searchBeatmapsByMappers } from "../../lib/osu";
import type { DanEstimate } from "../../lib/dan-estimator";
import type { OsuBeatmap, OsuBeatmapset, OsuScore } from "../../lib/types";
import { canUseDevFeatures } from "../../lib/auth-shared";
import {
  type DanBenchmarkFamily,
  getBenchmarkBeatmapsetIds,
  getBenchmarkLabelOptions,
} from "../../lib/dan-benchmark-sets";
import { getDanBenchmarkHiddenDiffs, getDanBenchmarkLabels, setDanBenchmarkHiddenDiff, setDanBenchmarkLabel } from "../../lib/dan-benchmark";

type DanClassifierId = "aleju" | "daniel";

const DAN_CLASSIFIERS: Array<{ id: DanClassifierId; label: string }> = [
  { id: "aleju", label: "aleju" },
  { id: "daniel", label: "Daniel" },
];

const DAN_IMAGE_EXTENSIONS: Record<string, "webp" | "svg"> = {
  "1": "svg",
  "2": "svg",
  "3": "svg",
  "4": "svg",
  "5": "svg",
  "6": "svg",
  "7": "svg",
  "8": "svg",
  "9": "svg",
  "10": "svg",
  alpha: "webp",
  beta: "webp",
  gamma: "webp",
  delta: "webp",
  epsilon: "webp",
  zeta: "webp",
  eta: "webp",
};
const NON_MAPPER_SEARCH_TOKENS = new Set([
  "4k",
  "7k",
  "9k",
  "dan",
  "map",
  "maps",
  "mania",
  "osu",
  "rate",
  "x",
]);

function extractMapperCandidates(query: string): string[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w[\]-]+|[^\w[\]-]+$/g, ""))
    .filter((token) => /^[\w[\]-]{3,24}$/.test(token))
    .filter((token) => !NON_MAPPER_SEARCH_TOKENS.has(token.toLowerCase()));
  const lastToken = tokens.at(-1);
  const likelyUserTokens = tokens.filter((token) => /[\d_[\]-]/.test(token));

  return [...new Set([...(lastToken ? [lastToken] : []), ...likelyUserTokens])].slice(0, 3);
}

function mergeBeatmapsets(...groups: OsuBeatmapset[][]): OsuBeatmapset[] {
  const beatmapsetsById = new Map<number, OsuBeatmapset>();
  for (const group of groups) {
    for (const beatmapset of group) {
      const existing = beatmapsetsById.get(beatmapset.id);
      if (!existing) {
        beatmapsetsById.set(beatmapset.id, beatmapset);
        continue;
      }

      const existingBeatmaps = existing.beatmaps ?? [];
      const beatmapsById = new Map(existingBeatmaps.map((beatmap) => [beatmap.id, beatmap]));
      for (const beatmap of beatmapset.beatmaps ?? []) {
        if (!beatmapsById.has(beatmap.id)) beatmapsById.set(beatmap.id, beatmap);
      }
      beatmapsetsById.set(beatmapset.id, {
        ...existing,
        beatmaps: [...beatmapsById.values()],
      });
    }
  }
  return [...beatmapsetsById.values()];
}

function topPlayScoresToBeatmapsets(scores: OsuScore[]): OsuBeatmapset[] {
  const beatmapsetsById = new Map<number, OsuBeatmapset>();
  const seenBeatmaps = new Set<number>();

  for (const score of scores) {
    const beatmap = score.beatmap;
    const beatmapset = score.beatmapset;
    if (!beatmap || !beatmapset || beatmap.mode !== "mania" || beatmap.cs !== 4 || seenBeatmaps.has(beatmap.id)) {
      continue;
    }

    seenBeatmaps.add(beatmap.id);
    const existing = beatmapsetsById.get(beatmapset.id);
    beatmapsetsById.set(beatmapset.id, {
      ...beatmapset,
      beatmaps: [...(existing?.beatmaps ?? []), beatmap],
    });
  }

  return [...beatmapsetsById.values()];
}

function extractBeatmapsetId(query: string): number | null {
  const beatmapsetUrlMatch = query.match(/beatmapsets\/(\d+)/i);
  const numericQueryMatch = query.trim().match(/^(\d{5,})$/);
  const id = Number(beatmapsetUrlMatch?.[1] ?? numericQueryMatch?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function extractBeatmapId(query: string): number | null {
  const beatmapUrlMatch = query.match(/(?:beatmaps\/|#mania\/)(\d+)/i);
  const numericQueryMatch = query.trim().match(/^(\d{5,})$/);
  const id = Number(beatmapUrlMatch?.[1] ?? numericQueryMatch?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getDanImageSrc(label: string, family?: string): string | null {
  if (family === "ln" && /^(1[0-6]|[1-9])$/.test(label)) {
    return `/images/dans/ln/${label}.svg`;
  }

  const extension = DAN_IMAGE_EXTENSIONS[label];
  return extension ? `/images/dans/reform/${label}.${extension}` : null;
}

function isNumericDanLabel(label: string): boolean {
  return /^(10|[1-9])$/.test(label);
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type BenchmarkExportAction = "excel" | "markdown";
type BenchmarkExportStatus = "idle" | "working" | "done" | "error";

interface BenchmarkExportState {
  action: BenchmarkExportAction | null;
  status: BenchmarkExportStatus;
}

interface BenchmarkExportRow {
  family: DanBenchmarkFamily;
  beatmapsetId: number;
  beatmapId: number;
  artist: string;
  title: string;
  creator: string;
  version: string;
  sr: number;
  expectedDan: string | null;
  detectedDan: string | null;
  detectedFamily: string | null;
  match: boolean | null;
  osuUrl: string;
}

type BenchmarkExportDataset = Record<DanBenchmarkFamily, BenchmarkExportRow[]>;

type BenchmarkExportColumnKey = Exclude<keyof BenchmarkExportRow, "family">;

interface BenchmarkExportColumn {
  key: BenchmarkExportColumnKey;
  label: string;
  width: number;
  type?: "number";
}

const BENCHMARK_EXPORT_FAMILIES: DanBenchmarkFamily[] = ["normal", "ln"];

const BENCHMARK_EXPORT_COLUMNS: BenchmarkExportColumn[] = [
  { key: "beatmapsetId", label: "Beatmapset ID", width: 90, type: "number" },
  { key: "beatmapId", label: "Beatmap ID", width: 85, type: "number" },
  { key: "artist", label: "Artist", width: 160 },
  { key: "title", label: "Title", width: 190 },
  { key: "creator", label: "Creator", width: 120 },
  { key: "version", label: "Difficulty", width: 220 },
  { key: "sr", label: "SR", width: 55, type: "number" },
  { key: "expectedDan", label: "Expected Dan", width: 95 },
  { key: "detectedDan", label: "Detected Dan", width: 95 },
  { key: "detectedFamily", label: "Detected Family", width: 105 },
  { key: "match", label: "Match", width: 65 },
  { key: "osuUrl", label: "osu! URL", width: 250 },
];

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function formatBenchmarkFamily(family: DanBenchmarkFamily): string {
  return family === "ln" ? "LN" : "Normal";
}

function getBenchmarkExportCellValue(row: BenchmarkExportRow, key: BenchmarkExportColumnKey): string | number {
  if (key === "match") {
    return row.match == null ? "" : row.match ? "yes" : "no";
  }
  if (key === "sr") {
    return Number(row.sr.toFixed(2));
  }
  return row[key] ?? "";
}

function escapeMarkdownCell(value: string | number): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildBenchmarkDatasetMarkdown(dataset: BenchmarkExportDataset): string {
  const lines = ["# Dan Classifier Benchmark Dataset", ""];

  for (const family of BENCHMARK_EXPORT_FAMILIES) {
    const rows = dataset[family];
    lines.push(`## ${formatBenchmarkFamily(family)}`, "");
    lines.push(`| ${BENCHMARK_EXPORT_COLUMNS.map((column) => column.label).join(" | ")} |`);
    lines.push(`| ${BENCHMARK_EXPORT_COLUMNS.map(() => "---").join(" | ")} |`);

    if (rows.length === 0) {
      lines.push(`| ${BENCHMARK_EXPORT_COLUMNS.map(() => "").join(" | ")} |`);
    } else {
      for (const row of rows) {
        lines.push(`| ${BENCHMARK_EXPORT_COLUMNS.map((column) => (
          escapeMarkdownCell(getBenchmarkExportCellValue(row, column.key))
        )).join(" | ")} |`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getXlsxCellStyle(row: BenchmarkExportRow | null, key: BenchmarkExportColumnKey | null): number {
  if (!row || !key) return 1;
  if (key === "sr") return 3;
  if (key === "beatmapsetId" || key === "beatmapId") return 2;
  if (key === "match" && row.match === true) return 4;
  if (key === "match" && row.match === false) return 5;
  return 0;
}

function getXlsxColumnName(index: number): string {
  let cursor = index + 1;
  let name = "";
  while (cursor > 0) {
    const remainder = (cursor - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    cursor = Math.floor((cursor - remainder - 1) / 26);
  }
  return name;
}

function xlsxCell(ref: string, value: string | number, styleIndex: number, isNumber: boolean): string {
  if (value === "") return `<c r="${ref}" s="${styleIndex}"/>`;
  if (isNumber) return `<c r="${ref}" s="${styleIndex}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function buildXlsxRow(rowIndex: number, values: Array<{
  value: string | number;
  styleIndex: number;
  isNumber: boolean;
}>): string {
  return `<row r="${rowIndex}">${values.map((cell, columnIndex) => (
    xlsxCell(`${getXlsxColumnName(columnIndex)}${rowIndex}`, cell.value, cell.styleIndex, cell.isNumber)
  )).join("")}</row>`;
}

function buildXlsxWorksheet(rows: BenchmarkExportRow[]): string {
  const rowCount = rows.length + 1;
  const lastColumn = getXlsxColumnName(BENCHMARK_EXPORT_COLUMNS.length - 1);
  const columns = BENCHMARK_EXPORT_COLUMNS.map((column, index) => {
    const width = Math.max(8, Math.round((column.width / 7) * 10) / 10);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const header = buildXlsxRow(1, BENCHMARK_EXPORT_COLUMNS.map((column) => ({
    value: column.label,
    styleIndex: 1,
    isNumber: false,
  })));
  const body = rows.map((row, index) => buildXlsxRow(index + 2, BENCHMARK_EXPORT_COLUMNS.map((column) => ({
    value: getBenchmarkExportCellValue(row, column.key),
    styleIndex: getXlsxCellStyle(row, column.key),
    isNumber: column.type === "number",
  })))).join("");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    `<cols>${columns}</cols>`,
    `<sheetData>${header}${body}</sheetData>`,
    `<autoFilter ref="A1:${lastColumn}${rowCount}"/>`,
    "</worksheet>",
  ].join("");
}

function buildXlsxStyles(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="4">',
    '<font><sz val="10"/><name val="Aptos"/></font>',
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>',
    '<font><b/><sz val="10"/><color rgb="FF047857"/><name val="Aptos"/></font>',
    '<font><b/><sz val="10"/><color rgb="FFB91C1C"/><name val="Aptos"/></font>',
    "</fonts>",
    '<fills count="5">',
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE6579A"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDDFCEB"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE2E2"/><bgColor indexed="64"/></patternFill></fill>',
    "</fills>",
    '<borders count="2">',
    "<border/>",
    '<border><bottom style="thin"><color rgb="FFE8D8E3"/></bottom></border>',
    "</borders>",
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="6">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="center"/></xf>',
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="center"/></xf>',
    '<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>',
    '<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>',
    "</cellXfs>",
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    "</styleSheet>",
  ].join("");
}

function buildXlsxContentTypes(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    BENCHMARK_EXPORT_FAMILIES.map((_, index) => (
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )).join(""),
    "</Types>",
  ].join("");
}

async function buildBenchmarkDatasetWorkbook(dataset: BenchmarkExportDataset): Promise<Blob> {
  const zip = new JSZip();
  const createdAt = new Date().toISOString();

  zip.file("[Content_Types].xml", buildXlsxContentTypes());
  zip.file("_rels/.rels", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join(""));
  zip.file("docProps/app.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>mania-hub</Application>",
    "</Properties>",
  ].join(""));
  zip.file("docProps/core.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    "<dc:title>Dan Classifier Benchmark Dataset</dc:title>",
    "<dc:creator>mania-hub</dc:creator>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>`,
    "</cp:coreProperties>",
  ].join(""));
  zip.file("xl/workbook.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheets>",
    BENCHMARK_EXPORT_FAMILIES.map((family, index) => (
      `<sheet name="${formatBenchmarkFamily(family)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )).join(""),
    "</sheets>",
    "</workbook>",
  ].join(""));
  zip.file("xl/_rels/workbook.xml.rels", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    BENCHMARK_EXPORT_FAMILIES.map((_, index) => (
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )).join(""),
    `<Relationship Id="rId${BENCHMARK_EXPORT_FAMILIES.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>",
  ].join(""));
  zip.file("xl/styles.xml", buildXlsxStyles());

  BENCHMARK_EXPORT_FAMILIES.forEach((family, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, buildXlsxWorksheet(dataset[family]));
  });

  return zip.generateAsync({ type: "blob", mimeType: XLSX_CONTENT_TYPE });
}

function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadTextFile(filename: string, contents: string, type: string): void {
  downloadBlobFile(filename, new Blob([contents], { type }));
}

async function runEstimate(
  beatmapset: OsuBeatmapset,
  beatmap: OsuBeatmap,
  classifierId: DanClassifierId,
  rate: number,
): Promise<DanEstimate> {
  const file = await getBeatmapFile({ data: { beatmapId: beatmap.id } });
  const parsed = parseManiaBeatmap(file.content);
  if (parsed.keyCount !== 4) {
    throw new Error("Dan estimates are currently only supported for 4K beatmaps.");
  }
  const estimateInput = {
    starRating: beatmap.difficulty_rating,
    totalLength: beatmap.total_length,
    title: beatmapset.title,
    version: beatmap.version,
    rate,
  };
  return classifierId === "daniel"
    ? estimateDanielDan(parsed, estimateInput)
    : estimateDan(parsed, estimateInput);
}

type DanVariant = "--" | "-" | "" | "+" | "++";
const DAN_VARIANT_OPTIONS: DanVariant[] = ["--", "-", "", "+", "++"];

function splitExpectedLabel(label: string): { base: string; variant: DanVariant } {
  const match = label.match(/^(.+?)(\+\+|--|\+|-)?$/);
  if (!match) return { base: label, variant: "" };
  return { base: match[1], variant: (match[2] ?? "") as DanVariant };
}

function joinExpectedLabel(base: string, variant: DanVariant): string {
  return `${base}${variant}`;
}

async function mapWithConcurrencyClient<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const Route = createFileRoute("/admin/dan-classifier")({
  head: () => ({
    meta: [
      { title: "Dan Classifier - dev" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: DanClassifierPage,
});

function DanClassifierPage() {
  const [view, setView] = useState<"search" | "benchmark">("search");
  const [benchmarkFamily, setBenchmarkFamily] = useState<DanBenchmarkFamily>("normal");
  const [query, setQuery] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [rate, setRate] = useState(1);
  const [classifier, setClassifier] = useState<DanClassifierId>("aleju");
  const [results, setResults] = useState<OsuBeatmapset[]>([]);
  const [showingPlayerMaps, setShowingPlayerMaps] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [playerMapsLoading, setPlayerMapsLoading] = useState(false);
  const [loadedPlayerName, setLoadedPlayerName] = useState<string | null>(null);
  const [selectedSet, setSelectedSet] = useState<OsuBeatmapset | null>(null);
  const [selectedBeatmap, setSelectedBeatmap] = useState<OsuBeatmap | null>(null);
  const [estimate, setEstimate] = useState<DanEstimate | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [copiedBeatmapId, setCopiedBeatmapId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (query.trim().length < 2) {
      if (!showingPlayerMaps) {
        setResults([]);
      }
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const directBeatmapsetId = extractBeatmapsetId(query);
        const directBeatmapId = extractBeatmapId(query);
        const [relevanceResponse, updatedResponse, directBeatmapset, directBeatmapParentSet] = await Promise.all([
          searchBeatmaps({
            data: {
              query,
              sort: "relevance_desc",
              status: "any",
            },
          }),
          searchBeatmaps({
            data: {
              query,
              sort: "updated_desc",
              status: "any",
            },
          }).catch(() => ({ beatmapsets: [] })),
          directBeatmapsetId
            ? getBeatmapset({ data: { beatmapsetId: directBeatmapsetId } }).catch(() => null)
            : Promise.resolve(null),
          directBeatmapId
            ? getBeatmapsetForBeatmap({ data: { beatmapId: directBeatmapId } }).catch(() => null)
            : Promise.resolve(null),
        ]);
        const mapperCandidates = extractMapperCandidates(query);
        const mapperResponse = mapperCandidates.length > 0
          ? await searchBeatmapsByMappers({ data: { usernames: mapperCandidates } })
          : { beatmapsets: [] };
        const searchedResults = filterBeatmapSearchResults(
          mergeBeatmapsets(relevanceResponse.beatmapsets, updatedResponse.beatmapsets, mapperResponse.beatmapsets),
          query,
        );
        setResults(mergeBeatmapsets(
          directBeatmapset ? [directBeatmapset] : [],
          directBeatmapParentSet ? [directBeatmapParentSet] : [],
          searchedResults,
        ).slice(0, 12));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not search beatmaps.");
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timerRef.current);
  }, [query, showingPlayerMaps]);

  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  const selectedTitle = useMemo(() => {
    if (!selectedSet || !selectedBeatmap) return null;
    return `${selectedSet.artist} - ${selectedSet.title} [${selectedBeatmap.version}]`;
  }, [selectedBeatmap, selectedSet]);

  const analyzeBeatmap = useCallback(async (beatmapset: OsuBeatmapset, beatmap: OsuBeatmap, classifierId: DanClassifierId = classifier) => {
    setSelectedSet(beatmapset);
    setSelectedBeatmap(beatmap);
    setEstimate(null);
    setError(null);
    setAnalysisLoading(true);

    try {
      const result = await runEstimate(beatmapset, beatmap, classifierId, rate);
      setEstimate(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze this beatmap.");
    } finally {
      setAnalysisLoading(false);
    }
  }, [classifier, rate]);

  async function loadPlayerTopPlayMaps() {
    const key = playerQuery.trim();
    if (key.length < 2) {
      setError("Enter a player username or ID.");
      return;
    }

    setPlayerMapsLoading(true);
    setError(null);

    try {
      const user = await getUser({ data: { key } });
      const scores = await getUserScoresBestWindow({ data: { userId: user.id, totalLimit: 100 } });
      const beatmapsets = topPlayScoresToBeatmapsets(scores);
      setLoadedPlayerName(user.username);
      setShowingPlayerMaps(true);
      setResults(beatmapsets);
      setQuery("");
      if (beatmapsets.length === 0) {
        setError(`${user.username} has no 4K mania maps in their top plays.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this player's top plays.");
    } finally {
      setPlayerMapsLoading(false);
    }
  }

  async function copyBeatmapId(beatmapId: number) {
    const copied = await copyTextToClipboard(String(beatmapId));
    if (!copied) return;

    setCopiedBeatmapId(beatmapId);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedBeatmapId(null), 1200);
  }

  return (
    <main className="min-h-screen overflow-x-clip bg-osu-b5 text-osu-c1">
      <div className="max-w-[1200px] mx-auto px-4 py-7 sm:px-5 sm:py-10">
        <div className="pb-6 border-b border-osu-b3/30">
          <div className="text-[11px] uppercase tracking-[0.16em] text-osu-yellow font-bold">
            Admin
          </div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white">
            Dan Classifier
          </h1>
          <div className="mt-2 text-sm text-osu-f1">
            Search a mania beatmap, fetch its .osu file, and estimate the dan range from chart pressure.
          </div>
        </div>

        <div className="mt-5 flex items-center gap-1 border-b border-osu-b3/30">
          <ViewTab active={view === "search"} onClick={() => setView("search")}>Search</ViewTab>
          <ViewTab active={view === "benchmark"} onClick={() => setView("benchmark")}>Benchmark</ViewTab>
        </div>

        <div
          className={`mt-6 grid min-w-0 gap-6 items-start ${
            view === "benchmark" && !selectedBeatmap
              ? "lg:grid-cols-1"
              : "lg:grid-cols-[minmax(0,1fr)_360px]"
          }`}
        >
          {view === "search" ? (
          <section className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4 sm:p-5">
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLoadedPlayerName(null);
                  setShowingPlayerMaps(false);
                  setError(null);
                }}
                placeholder="Search beatmap..."
                className="w-full px-4 py-3 rounded-lg bg-osu-b5 text-osu-c1 text-sm placeholder:text-osu-f1 border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none transition-colors shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)]"
              />
              {searchLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center gap-3">
              <label className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold" htmlFor="dan-rate">
                Rate
              </label>
              <input
                id="dan-rate"
                type="number"
                min="0.5"
                max="2"
                step="0.05"
                value={rate}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setRate(Math.max(0.5, Math.min(2, next)));
                }}
                className="w-24 px-3 py-2 rounded-md bg-osu-b5 text-osu-c1 text-xs border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none"
              />
              <div className="text-xs text-osu-f1">x</div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <label className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold" htmlFor="dan-classifier">
                Classifier
              </label>
              <select
                id="dan-classifier"
                value={classifier}
                onChange={(event) => {
                  const next = event.target.value as DanClassifierId;
                  setClassifier(next);
                  if (selectedSet && selectedBeatmap) void analyzeBeatmap(selectedSet, selectedBeatmap, next);
                }}
                className="w-32 px-3 py-2 rounded-md bg-osu-b5 text-osu-c1 text-xs border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none"
              >
                {DAN_CLASSIFIERS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="mt-4 rounded-lg border border-osu-b3/30 bg-osu-b5/60 p-3">
              <label className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold" htmlFor="dan-player-top-plays">
                Player top plays
              </label>
              <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
                <div className="relative min-w-0 flex-1">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1" />
                  <input
                    id="dan-player-top-plays"
                    type="text"
                    value={playerQuery}
                    onChange={(event) => {
                      setPlayerQuery(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void loadPlayerTopPlayMaps();
                    }}
                    placeholder="Username or ID..."
                    className="w-full rounded-md border border-osu-b3/50 bg-osu-b5 py-2 pl-9 pr-3 text-sm text-osu-c1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)] transition-colors placeholder:text-osu-f1 focus:border-osu-h1/40 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void loadPlayerTopPlayMaps()}
                  disabled={playerMapsLoading}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-osu-pink/30 bg-osu-pink/20 px-3 text-xs font-black text-white transition-colors hover:border-osu-pink/60 hover:bg-osu-pink/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {playerMapsLoading ? (
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Load 4K maps
                </button>
              </div>
              {loadedPlayerName && !playerMapsLoading ? (
                <div className="mt-2 text-[11px] text-osu-f1">
                  Showing 4K maps from {loadedPlayerName}'s top plays.
                </div>
              ) : null}
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3 text-sm text-osu-red">
                {error}
              </div>
            )}

            <div className="mt-5 space-y-3">
              {results.map((beatmapset) => {
                const maniaDiffs = (beatmapset.beatmaps ?? [])
                  .filter((beatmap) => beatmap.mode === "mania")
                  .sort((a, b) => a.cs - b.cs || a.difficulty_rating - b.difficulty_rating);
                const coverUrl = beatmapset.covers?.["cover@2x"] || beatmapset.covers?.cover;
                const copiedMapId = beatmapset.id;

                return (
                  <div key={beatmapset.id} className="relative min-w-0 overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b5">
                    {coverUrl && (
                      <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" loading="lazy" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-r from-osu-b5 via-osu-b5/90 to-osu-b5/65" />
                    <div className="relative p-4">
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-black text-white truncate">{beatmapset.title}</div>
                          <div className="mt-1 text-[11px] text-osu-f1 truncate">
                            {beatmapset.artist} // {beatmapset.creator}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void copyBeatmapId(copiedMapId)}
                            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-black/35 text-osu-l2 backdrop-blur-sm transition-colors hover:border-osu-l2/40 hover:bg-black/55 hover:text-white"
                            title={`Copy beatmapset ID ${copiedMapId}`}
                            aria-label={`Copy beatmapset ID ${copiedMapId}`}
                          >
                            {copiedBeatmapId === copiedMapId ? (
                              <Check className="h-3.5 w-3.5" strokeWidth={3} />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <a
                            href={`https://osu.ppy.sh/beatmapsets/${beatmapset.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-bold text-osu-l2 hover:text-white transition-colors"
                          >
                            osu!
                          </a>
                        </div>
                      </div>

                      <div className="mt-3 flex min-w-0 flex-wrap gap-1.5 overflow-hidden">
                        {maniaDiffs.map((beatmap) => (
                          <button
                            key={beatmap.id}
                            type="button"
                            onClick={() => analyzeBeatmap(beatmapset, beatmap)}
                            className={`inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden px-2.5 py-1 rounded-md text-left text-[11px] cursor-pointer transition-colors border backdrop-blur-sm ${
                              selectedBeatmap?.id === beatmap.id
                                ? "bg-osu-pink/30 border-osu-pink/60 text-white"
                                : "bg-black/40 hover:bg-black/60 border-white/10 text-white/90"
                            }`}
                          >
                            <span className="shrink-0 text-osu-yellow font-semibold">{beatmap.cs}K</span>
                            <span className="min-w-0 truncate">{beatmap.version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim()}</span>
                            <span className="shrink-0 text-osu-l2">&#9733;{beatmap.difficulty_rating.toFixed(2)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}

              {!searchLoading && query.trim().length >= 2 && results.length === 0 && (
                <div className="py-12 text-center text-sm text-osu-f1">No mania beatmaps found.</div>
              )}

              {query.trim().length < 2 && results.length === 0 && (
                <div className="py-12 text-center text-sm text-osu-f1">Start typing to search osu!mania maps.</div>
              )}
            </div>
          </section>
          ) : (
            <BenchmarkView
              family={benchmarkFamily}
              onFamilyChange={setBenchmarkFamily}
              classifier={classifier}
              onClassifierChange={setClassifier}
              rate={rate}
              onRateChange={setRate}
              selectedBeatmapId={selectedBeatmap?.id ?? null}
              onAnalyze={analyzeBeatmap}
              onCopyId={copyBeatmapId}
              copiedBeatmapId={copiedBeatmapId}
            />
          )}

          {!(view === "benchmark" && !selectedBeatmap) && (
          <aside className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4 sm:p-5 lg:sticky lg:top-24">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">Estimate</div>
                <div className="mt-1 text-[11px] font-bold text-osu-yellow">
                  {DAN_CLASSIFIERS.find((option) => option.id === classifier)?.label}
                </div>
              </div>
              {view === "benchmark" && selectedBeatmap ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSet(null);
                    setSelectedBeatmap(null);
                    setEstimate(null);
                  }}
                  className="cursor-pointer rounded-md border border-osu-b3/40 bg-osu-b5/60 px-2 py-1 text-[10px] text-osu-f1 hover:text-white hover:border-osu-b3 transition-colors"
                  title="Close detail"
                >
                  Close
                </button>
              ) : null}
            </div>
            {analysisLoading ? (
              <div className="mt-8 flex flex-col items-center gap-3 py-10">
                <div className="w-7 h-7 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <div className="text-sm text-osu-f1">Analyzing .osu file...</div>
              </div>
            ) : estimate ? (
              <div className="mt-4 min-w-0">
                <div className="text-sm text-osu-f1 truncate">{selectedTitle}</div>
                <div className="mt-4 flex items-center gap-4">
                  {getDanImageSrc(estimate.label, estimate.family) ? (
                    <img
                      src={getDanImageSrc(estimate.label, estimate.family) ?? undefined}
                      alt=""
                      className="h-16 w-16 shrink-0 object-contain drop-shadow-[0_10px_24px_rgba(0,0,0,0.45)] sm:h-20 sm:w-20"
                    />
                  ) : null}
                  <div className="min-w-0">
                    {!isNumericDanLabel(estimate.label) && (
                      <div className="truncate text-3xl font-black leading-none text-white sm:text-4xl">{estimate.displayName}</div>
                    )}
                    <div className={`${isNumericDanLabel(estimate.label) ? "" : "mt-2"} text-sm font-bold text-osu-yellow`}>
                      {estimate.family}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-sm text-osu-f1">
                  SR proxy {estimate.estimatedSr.toFixed(2)} · raw dan {estimate.rawDan.toFixed(2)}
                </div>

                <div className="mt-5 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                  <Metric label="Notes" value={estimate.metrics.noteCount.toLocaleString()} />
                  <Metric label="Keys" value={`${estimate.metrics.keyCount}K`} />
                  <Metric label="Peak 5s" value={`${estimate.metrics.peakNps5s.toFixed(1)} n/s`} />
                  <Metric label="Sustain 10s" value={`${estimate.metrics.sustainedNps10s.toFixed(1)} n/s`} />
                  <Metric label="Chords" value={`${Math.round(estimate.metrics.chordRatio * 100)}%`} />
                  <Metric label="LNs" value={`${Math.round(estimate.metrics.holdRatio * 100)}%`} />
                </div>

                <div className="mt-5 space-y-2">
                  {(() => {
                    const scores = Object.entries(estimate.skillScores)
                      .filter(([skill]) => skill !== "dan") as Array<[string, number]>;
                    const values = scores.map(([, score]) => score);
                    const minScore = Math.min(...values);
                    const maxScore = Math.max(...values);
                    const spread = Math.max(0.001, maxScore - minScore);

                    return scores.map(([skill, score]) => (
                      <div key={skill}>
                        <div className="flex justify-between text-[11px] font-bold text-osu-f1">
                          <span className="capitalize">{skill}</span>
                          <span>{score.toFixed(2)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-osu-b5 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-osu-pink"
                            style={{ width: `${Math.min(100, Math.max(4, ((score - minScore) / spread) * 96 + 4))}%` }}
                          />
                        </div>
                      </div>
                    ));
                  })()}
                </div>

                {estimate.warnings.length > 0 && (
                  <div className="mt-5 rounded-lg border border-osu-yellow/25 bg-osu-yellow/10 px-3 py-2 text-[11px] text-osu-yellow">
                    {estimate.warnings.join(" ")}
                  </div>
                )}

                {selectedSet && selectedBeatmap && (
                  <Link
                    to="/replay"
                    search={{ tab: "beatmap" }}
                    className="mt-5 block text-center px-3 py-2 rounded-lg bg-osu-b5 text-[11px] font-bold text-osu-l2 border border-osu-b3/40 hover:text-white hover:border-osu-b3 transition-colors"
                  >
                    Find replays for this map
                  </Link>
                )}
              </div>
            ) : (
              <div className="mt-8 py-10 text-center text-sm text-osu-f1">
                Pick a difficulty to estimate its dan.
              </div>
            )}
          </aside>
          )}
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-osu-b5 border border-osu-b3/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-osu-f1 font-bold">{label}</div>
      <div className="mt-1 truncate text-sm font-black text-white">{value}</div>
    </div>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-4 py-2 text-[11px] uppercase tracking-[0.14em] font-bold cursor-pointer transition-colors ${
        active ? "text-white" : "text-osu-f1 hover:text-osu-c1"
      }`}
    >
      {children}
      {active ? (
        <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-osu-pink" />
      ) : null}
    </button>
  );
}

interface BenchmarkRow {
  beatmapsetId: number;
  beatmapset: OsuBeatmapset | null;
  beatmap: OsuBeatmap | null;
  estimate: DanEstimate | null;
  status: "pending" | "loading" | "ready" | "error";
  error: string | null;
}

interface BenchmarkSetState {
  beatmapsetId: number;
  beatmapset: OsuBeatmapset | null;
  status: "pending" | "loading" | "ready" | "error";
  error: string | null;
  rows: BenchmarkRow[];
}

interface BenchmarkViewProps {
  family: DanBenchmarkFamily;
  onFamilyChange: (family: DanBenchmarkFamily) => void;
  classifier: DanClassifierId;
  onClassifierChange: (classifier: DanClassifierId) => void;
  rate: number;
  onRateChange: (rate: number) => void;
  selectedBeatmapId: number | null;
  onAnalyze: (set: OsuBeatmapset, beatmap: OsuBeatmap) => void;
  onCopyId: (id: number) => void;
  copiedBeatmapId: number | null;
}

function BenchmarkView({
  family,
  onFamilyChange,
  classifier,
  onClassifierChange,
  rate,
  onRateChange,
  selectedBeatmapId,
  onAnalyze,
  onCopyId,
  copiedBeatmapId,
}: BenchmarkViewProps) {
  // family-keyed cache so switching tabs doesn't re-fetch
  const cacheRef = useRef<Map<DanBenchmarkFamily, BenchmarkSetState[]>>(new Map());
  const [sets, setSets] = useState<BenchmarkSetState[]>([]);
  const [expectedLabelsByFamily, setExpectedLabelsByFamily] = useState<Record<DanBenchmarkFamily, Map<number, string>>>({
    normal: new Map(),
    ln: new Map(),
  });
  const [hiddenByFamily, setHiddenByFamily] = useState<Record<DanBenchmarkFamily, Set<number>>>({
    normal: new Set(),
    ln: new Set(),
  });
  const [labelsLoaded, setLabelsLoaded] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [exportState, setExportState] = useState<BenchmarkExportState>({ action: null, status: "idle" });
  const exportTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const expectedLabels = expectedLabelsByFamily[family];
  const hiddenSet = hiddenByFamily[family];
  const labelOptions = useMemo(() => getBenchmarkLabelOptions(family), [family]);

  // load expected labels + hidden diffs for both families once
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [normalRows, lnRows, normalHidden, lnHidden] = await Promise.all([
          getDanBenchmarkLabels({ data: { family: "normal" } }),
          getDanBenchmarkLabels({ data: { family: "ln" } }),
          getDanBenchmarkHiddenDiffs({ data: { family: "normal" } }),
          getDanBenchmarkHiddenDiffs({ data: { family: "ln" } }),
        ]);
        if (cancelled) return;
        const normalMap = new Map<number, string>();
        for (const row of normalRows) normalMap.set(row.beatmapId, row.expectedLabel);
        const lnMap = new Map<number, string>();
        for (const row of lnRows) lnMap.set(row.beatmapId, row.expectedLabel);
        setExpectedLabelsByFamily({ normal: normalMap, ln: lnMap });
        setHiddenByFamily({ normal: new Set(normalHidden), ln: new Set(lnHidden) });
        setLabelsLoaded(true);
      } catch {
        if (!cancelled) setLabelsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => clearTimeout(exportTimerRef.current), []);

  // run estimates whenever family/classifier/rate changes
  useEffect(() => {
    let cancelled = false;
    const cached = cacheRef.current.get(family);

    if (cached) {
      setSets(cached);
      // re-estimate when classifier/rate change
      void runEstimatesForSets(cached);
      return () => {
        cancelled = true;
      };
    }

    const ids = getBenchmarkBeatmapsetIds(family);
    const initial: BenchmarkSetState[] = ids.map((id) => ({
      beatmapsetId: id,
      beatmapset: null,
      status: "pending",
      error: null,
      rows: [],
    }));
    setSets(initial);

    void (async () => {
      const fetched = await mapWithConcurrencyClient(ids, 4, async (id) => {
        try {
          const beatmapset = await getBeatmapset({ data: { beatmapsetId: id } });
          return { id, beatmapset, error: null as string | null };
        } catch (err) {
          return { id, beatmapset: null as OsuBeatmapset | null, error: err instanceof Error ? err.message : "Failed to fetch beatmapset." };
        }
      });
      if (cancelled) return;

      const next: BenchmarkSetState[] = fetched.map(({ id, beatmapset, error }) => {
        if (!beatmapset) {
          return {
            beatmapsetId: id,
            beatmapset: null,
            status: "error" as const,
            error: error ?? "Failed to fetch beatmapset.",
            rows: [],
          };
        }
        const maniaDiffs = (beatmapset.beatmaps ?? [])
          .filter((bm) => bm.mode === "mania" && bm.cs === 4)
          .sort((a, b) => a.difficulty_rating - b.difficulty_rating);
        return {
          beatmapsetId: id,
          beatmapset,
          status: "ready" as const,
          error: null,
          rows: maniaDiffs.map((bm) => ({
            beatmapsetId: id,
            beatmapset,
            beatmap: bm,
            estimate: null,
            status: "pending" as const,
            error: null,
          })),
        };
      });

      cacheRef.current.set(family, next);
      setSets(next);
      await runEstimatesForSets(next);
    })();

    async function runEstimatesForSets(target: BenchmarkSetState[]) {
      const allRows: Array<{ setIndex: number; rowIndex: number; row: BenchmarkRow }> = [];
      target.forEach((set, setIndex) => {
        set.rows.forEach((row, rowIndex) => {
          allRows.push({ setIndex, rowIndex, row });
        });
      });

      // mark all loading at once
      if (!cancelled) {
        setSets((prev) => prev.map((set) => ({
          ...set,
          rows: set.rows.map((row) => ({ ...row, status: "loading", estimate: null, error: null })),
        })));
      }

      await mapWithConcurrencyClient(allRows, 4, async ({ row }) => {
        if (!row.beatmapset || !row.beatmap) return;
        try {
          const estimate = await runEstimate(row.beatmapset, row.beatmap, classifier, rate);
          if (cancelled) return;
          setSets((prev) => updateRow(prev, row.beatmapsetId, row.beatmap!.id, {
            estimate,
            status: "ready",
            error: null,
          }));
          // also update cache
          const cachedFamily = cacheRef.current.get(family);
          if (cachedFamily) {
            cacheRef.current.set(family, updateRow(cachedFamily, row.beatmapsetId, row.beatmap.id, {
              estimate,
              status: "ready",
              error: null,
            }));
          }
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : "Could not estimate.";
          setSets((prev) => updateRow(prev, row.beatmapsetId, row.beatmap!.id, {
            estimate: null,
            status: "error",
            error: message,
          }));
        }
      });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, classifier, rate]);

  async function handleToggleHidden(beatmapId: number, hidden: boolean) {
    setHiddenByFamily((prev) => {
      const next = new Set(prev[family]);
      if (hidden) next.add(beatmapId);
      else next.delete(beatmapId);
      return { ...prev, [family]: next };
    });
    try {
      await setDanBenchmarkHiddenDiff({
        data: { beatmapId, family, hidden },
      });
    } catch {
      // optimistic update remains until next reload
    }
  }

  async function handleExpectedChange(beatmapId: number, value: string) {
    setExpectedLabelsByFamily((prev) => {
      const next = new Map(prev[family]);
      if (value === "") {
        next.delete(beatmapId);
      } else {
        next.set(beatmapId, value);
      }
      return { ...prev, [family]: next };
    });
    try {
      await setDanBenchmarkLabel({
        data: {
          beatmapId,
          family,
          expectedLabel: value === "" ? null : value,
        },
      });
    } catch {
      // ignore: the optimistic update remains until the next reload
    }
  }

  async function buildExportDataset(): Promise<BenchmarkExportDataset> {
    const datasets = await Promise.all(BENCHMARK_EXPORT_FAMILIES.map(async (fam) => {
      const cached = cacheRef.current.get(fam);
      if (cached) return { family: fam, sets: cached };

      const ids = getBenchmarkBeatmapsetIds(fam);
      const fetched = await mapWithConcurrencyClient(ids, 4, async (id) => {
        try {
          const beatmapset = await getBeatmapset({ data: { beatmapsetId: id } });
          return { id, beatmapset, error: null as string | null };
        } catch (err) {
          return { id, beatmapset: null as OsuBeatmapset | null, error: err instanceof Error ? err.message : "Failed" };
        }
      });
      const setsState: BenchmarkSetState[] = fetched.map(({ id, beatmapset, error }) => ({
        beatmapsetId: id,
        beatmapset,
        status: beatmapset ? "ready" : "error",
        error,
        rows: beatmapset
          ? (beatmapset.beatmaps ?? [])
              .filter((bm) => bm.mode === "mania" && bm.cs === 4)
              .sort((a, b) => a.difficulty_rating - b.difficulty_rating)
              .map((bm) => ({
                beatmapsetId: id,
                beatmapset,
                beatmap: bm,
                estimate: null,
                status: "pending" as const,
                error: null,
              }))
          : [],
      }));
      cacheRef.current.set(fam, setsState);
      return { family: fam, sets: setsState };
    }));

    const dataset: BenchmarkExportDataset = { normal: [], ln: [] };

    for (const { family: fam, sets: famSets } of datasets) {
      for (const set of famSets) {
        if (!set.beatmapset) continue;
        for (const row of set.rows) {
          if (!row.beatmap) continue;
          if (hiddenByFamily[fam].has(row.beatmap.id)) continue;
          const expectedDan = expectedLabelsByFamily[fam].get(row.beatmap.id) ?? null;
          const detectedDan = row.estimate?.displayName ?? row.estimate?.label ?? null;
          const detectedBase = row.estimate?.label ?? null;
          const expectedBase = expectedDan ? splitExpectedLabel(expectedDan).base : null;
          dataset[fam].push({
            family: fam,
            beatmapsetId: set.beatmapset.id,
            beatmapId: row.beatmap.id,
            title: set.beatmapset.title,
            artist: set.beatmapset.artist,
            creator: set.beatmapset.creator,
            version: row.beatmap.version,
            sr: row.beatmap.difficulty_rating,
            expectedDan,
            detectedDan,
            detectedFamily: row.estimate?.family ?? null,
            match: expectedBase && detectedBase ? expectedBase === detectedBase : null,
            osuUrl: `https://osu.ppy.sh/beatmapsets/${set.beatmapset.id}#mania/${row.beatmap.id}`,
          });
        }
      }
    }

    return dataset;
  }

  async function handleExportDataset(action: BenchmarkExportAction) {
    setExportState({ action, status: "working" });
    try {
      const dataset = await buildExportDataset();
      const date = new Date().toISOString().slice(0, 10);

      if (action === "excel") {
        const workbook = await buildBenchmarkDatasetWorkbook(dataset);
        downloadBlobFile(`dan-benchmark-dataset-${date}.xlsx`, workbook);
      } else {
        const markdown = buildBenchmarkDatasetMarkdown(dataset);
        const copied = await copyTextToClipboard(markdown);
        if (!copied) {
          downloadTextFile(
            `dan-benchmark-dataset-${date}.md`,
            markdown,
            "text/markdown;charset=utf-8",
          );
        }
      }

      setExportState({ action, status: "done" });
    } catch {
      setExportState({ action, status: "error" });
    } finally {
      clearTimeout(exportTimerRef.current);
      exportTimerRef.current = setTimeout(() => setExportState({ action: null, status: "idle" }), 2000);
    }
  }

  const isVisibleRow = (row: BenchmarkRow) => row.beatmap !== null && !hiddenSet.has(row.beatmap.id);
  const totalDiffs = sets.reduce((sum, set) => sum + set.rows.filter(isVisibleRow).length, 0);
  const hiddenCount = sets.reduce((sum, set) => sum + set.rows.filter((row) => row.beatmap !== null && hiddenSet.has(row.beatmap.id)).length, 0);
  const readyCount = sets.reduce(
    (sum, set) => sum + set.rows.filter((row) => isVisibleRow(row) && row.status === "ready").length,
    0,
  );
  const exactMatchCount = sets.reduce((sum, set) => sum + set.rows.filter((row) => {
    if (!isVisibleRow(row)) return false;
    if (row.status !== "ready" || !row.estimate || !row.beatmap) return false;
    const expected = expectedLabels.get(row.beatmap.id);
    return expected ? expected === row.estimate.displayName : false;
  }).length, 0);
  const baseMatchCount = sets.reduce((sum, set) => sum + set.rows.filter((row) => {
    if (!isVisibleRow(row)) return false;
    if (row.status !== "ready" || !row.estimate || !row.beatmap) return false;
    const expected = expectedLabels.get(row.beatmap.id);
    if (!expected) return false;
    if (expected === row.estimate.displayName) return false;
    return splitExpectedLabel(expected).base === row.estimate.label;
  }).length, 0);
  const labeledCount = sets.reduce((sum, set) => sum + set.rows.filter((row) => isVisibleRow(row) && row.beatmap && expectedLabels.has(row.beatmap.id)).length, 0);
  const matchedCount = exactMatchCount + baseMatchCount;
  const wrongCount = Math.max(0, labeledCount - matchedCount);
  const modelAccuracy = labeledCount > 0 ? (matchedCount / labeledCount) * 100 : 0;
  const exactAccuracy = labeledCount > 0 ? (exactMatchCount / labeledCount) * 100 : 0;
  const exportBusy = exportState.status === "working";
  const getExportButtonStatus = (action: BenchmarkExportAction): BenchmarkExportStatus => (
    exportState.action === action ? exportState.status : "idle"
  );
  const getExportButtonClass = (action: BenchmarkExportAction): string => {
    const status = getExportButtonStatus(action);
    if (status === "done") return "border-emerald-400/50 bg-emerald-500/20 text-emerald-300";
    if (status === "error") return "border-osu-red/50 bg-osu-red/20 text-osu-red";
    return "border-osu-b3/50 bg-osu-b5 text-osu-c1 hover:border-osu-b3 hover:text-white";
  };
  const getExportButtonText = (action: BenchmarkExportAction): string => {
    const status = getExportButtonStatus(action);
    if (status === "working") return "...";
    if (status === "done") return "done";
    if (status === "error") return "failed";
    return action === "excel" ? "excel" : "markdown";
  };

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-2">
        <div className="flex items-center gap-1 rounded-md border border-osu-b3/40 bg-osu-b5/60 p-0.5">
          <SubTab active={family === "normal"} onClick={() => onFamilyChange("normal")}>Normal</SubTab>
          <SubTab active={family === "ln"} onClick={() => onFamilyChange("ln")}>LN</SubTab>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-osu-f1 sm:gap-3">
          <label className="flex items-center gap-1.5">
            <span className="uppercase tracking-wide font-bold">Classifier</span>
            <select
              value={classifier}
              onChange={(event) => onClassifierChange(event.target.value as DanClassifierId)}
              className="rounded border border-osu-b3/50 bg-osu-b5 px-1.5 py-0.5 text-osu-c1 focus:border-osu-h1/40 focus:outline-none cursor-pointer"
            >
              {DAN_CLASSIFIERS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="uppercase tracking-wide font-bold">Rate</span>
            <input
              type="number"
              min="0.5"
              max="2"
              step="0.05"
              value={rate}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) onRateChange(Math.max(0.5, Math.min(2, next)));
              }}
              className="w-16 rounded border border-osu-b3/50 bg-osu-b5 px-1.5 py-0.5 text-osu-c1 focus:border-osu-h1/40 focus:outline-none"
            />
          </label>
          <div>
            <span className="font-bold text-osu-c1">{readyCount}</span>/{totalDiffs}
          </div>
          {labeledCount > 0 && labelsLoaded ? (
            <>
              <div title={`${exactMatchCount} exact, ${baseMatchCount} base-only, ${wrongCount} wrong`}>
                <span className="font-bold text-emerald-300">{exactMatchCount}</span>
                {baseMatchCount > 0 ? <span className="text-osu-yellow">+{baseMatchCount}</span> : null}
                /{labeledCount}
              </div>
              <div
                className="inline-flex items-center gap-1 rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 font-bold text-emerald-300"
                title={`Total model accuracy: ${matchedCount}/${labeledCount} base-or-better. Exact accuracy: ${exactAccuracy.toFixed(1)}%. ${wrongCount} wrong.`}
              >
                <span className="uppercase tracking-wide text-osu-f1">Accuracy</span>
                <span className="tabular-nums">{modelAccuracy.toFixed(1)}%</span>
              </div>
            </>
          ) : null}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 font-bold uppercase tracking-wide cursor-pointer transition-colors ${
                showHidden
                  ? "border-osu-pink/50 bg-osu-pink/15 text-white"
                  : "border-osu-b3/50 bg-osu-b5 text-osu-f1 hover:text-osu-c1"
              }`}
              title={showHidden ? "Hide excluded diffs" : "Show excluded diffs"}
            >
              {showHidden ? "hide" : "show"} hidden ({hiddenCount})
            </button>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => void handleExportDataset("excel")}
              disabled={exportBusy}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 font-bold uppercase tracking-wide transition-colors cursor-pointer disabled:cursor-not-allowed ${getExportButtonClass("excel")}`}
              title="Download dataset (both families) as a styled Excel workbook"
            >
              <FileSpreadsheet className="h-3 w-3" />
              {getExportButtonText("excel")}
            </button>
            <button
              type="button"
              onClick={() => void handleExportDataset("markdown")}
              disabled={exportBusy}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 font-bold uppercase tracking-wide transition-colors cursor-pointer disabled:cursor-not-allowed ${getExportButtonClass("markdown")}`}
              title="Copy dataset (both families) as Markdown tables"
            >
              <ClipboardList className="h-3 w-3" />
              {getExportButtonText("markdown")}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {sets.map((set) => (
          <BenchmarkSetBlock
            key={set.beatmapsetId}
            set={set}
            labelOptions={labelOptions}
            expectedLabels={expectedLabels}
            hiddenSet={hiddenSet}
            showHidden={showHidden}
            onToggleHidden={handleToggleHidden}
            onExpectedChange={handleExpectedChange}
            onAnalyze={onAnalyze}
            onCopyId={onCopyId}
            copiedBeatmapId={copiedBeatmapId}
            selectedBeatmapId={selectedBeatmapId}
          />
        ))}
      </div>
    </section>
  );
}

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded text-[10px] uppercase tracking-[0.12em] font-bold cursor-pointer transition-colors ${
        active ? "bg-osu-pink/30 text-white" : "text-osu-f1 hover:text-osu-c1"
      }`}
    >
      {children}
    </button>
  );
}

function updateRow(
  sets: BenchmarkSetState[],
  beatmapsetId: number,
  beatmapId: number,
  patch: Partial<BenchmarkRow>,
): BenchmarkSetState[] {
  return sets.map((set) => {
    if (set.beatmapsetId !== beatmapsetId) return set;
    return {
      ...set,
      rows: set.rows.map((row) => (row.beatmap?.id === beatmapId ? { ...row, ...patch } : row)),
    };
  });
}

interface BenchmarkSetBlockProps {
  set: BenchmarkSetState;
  labelOptions: string[];
  expectedLabels: Map<number, string>;
  hiddenSet: Set<number>;
  showHidden: boolean;
  onToggleHidden: (beatmapId: number, hidden: boolean) => void;
  onExpectedChange: (beatmapId: number, value: string) => void;
  onAnalyze: (set: OsuBeatmapset, beatmap: OsuBeatmap) => void;
  onCopyId: (id: number) => void;
  copiedBeatmapId: number | null;
  selectedBeatmapId: number | null;
}

function BenchmarkSetBlock({
  set,
  labelOptions,
  expectedLabels,
  hiddenSet,
  showHidden,
  onToggleHidden,
  onExpectedChange,
  onAnalyze,
  onCopyId,
  copiedBeatmapId,
  selectedBeatmapId,
}: BenchmarkSetBlockProps) {
  if (set.status === "error") {
    return (
      <div className="rounded-md border border-osu-red/30 bg-osu-red/10 px-3 py-2 text-[11px] text-osu-red">
        Set #{set.beatmapsetId}: {set.error ?? "Failed to load."}
      </div>
    );
  }

  if (set.status === "pending" || !set.beatmapset) {
    return (
      <div className="rounded-md border border-osu-b3/30 bg-osu-b5/40 px-3 py-2 text-[11px] text-osu-f1">
        Loading set #{set.beatmapsetId}...
      </div>
    );
  }

  const beatmapset = set.beatmapset;
  const coverUrl = beatmapset.covers?.["cover@2x"] || beatmapset.covers?.cover || null;

  return (
    <div className="min-w-0 rounded-md border border-osu-b3/30 bg-osu-b5/40 overflow-hidden">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[11px] border-b border-osu-b3/20 bg-osu-b5/60">
        <span className="min-w-0 truncate text-white font-bold">{beatmapset.title}</span>
        <span className="shrink-0 text-osu-f1 truncate">// {beatmapset.creator}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCopyId(beatmapset.id)}
            className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-osu-l2 hover:text-white transition-colors"
            title={`Copy beatmapset ID ${beatmapset.id}`}
            aria-label={`Copy beatmapset ID ${beatmapset.id}`}
          >
            {copiedBeatmapId === beatmapset.id ? (
              <Check className="h-3 w-3" strokeWidth={3} />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
          <a
            href={`https://osu.ppy.sh/beatmapsets/${beatmapset.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-osu-l2 hover:text-white transition-colors"
          >
            osu!
          </a>
        </div>
      </div>

      {(() => {
        if (set.rows.length === 0) {
          return <div className="px-2.5 py-2 text-[11px] text-osu-f1">No 4K mania diffs.</div>;
        }
        const visibleRows = set.rows.filter((row) => {
          if (!row.beatmap) return true;
          if (hiddenSet.has(row.beatmap.id)) return showHidden;
          return true;
        });
        if (visibleRows.length === 0) {
          return <div className="px-2.5 py-2 text-[11px] text-osu-f1 italic">All diffs hidden.</div>;
        }
        return (
          <div className={`grid gap-1.5 p-1.5 ${visibleRows.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
            {visibleRows.map((row) => (
              <BenchmarkDiffRow
                key={row.beatmap?.id ?? Math.random()}
                row={row}
                coverUrl={coverUrl}
                labelOptions={labelOptions}
                expected={row.beatmap ? expectedLabels.get(row.beatmap.id) ?? "" : ""}
                isHidden={row.beatmap ? hiddenSet.has(row.beatmap.id) : false}
                onToggleHidden={onToggleHidden}
                onExpectedChange={onExpectedChange}
                onAnalyze={onAnalyze}
                isSelected={row.beatmap?.id === selectedBeatmapId}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}

interface BenchmarkDiffRowProps {
  row: BenchmarkRow;
  coverUrl: string | null;
  labelOptions: string[];
  expected: string;
  isHidden: boolean;
  onToggleHidden: (beatmapId: number, hidden: boolean) => void;
  onExpectedChange: (beatmapId: number, value: string) => void;
  onAnalyze: (set: OsuBeatmapset, beatmap: OsuBeatmap) => void;
  isSelected: boolean;
}

function BenchmarkDiffRow({ row, coverUrl, labelOptions, expected, isHidden, onToggleHidden, onExpectedChange, onAnalyze, isSelected }: BenchmarkDiffRowProps) {
  if (!row.beatmap || !row.beatmapset) return null;
  const beatmap = row.beatmap;
  const beatmapset = row.beatmapset;

  const estimateLabel = row.estimate?.label ?? null;
  const estimateDisplay = row.estimate?.displayName ?? estimateLabel;
  const estimateFamily = row.estimate?.family ?? null;
  const estimateImage = estimateLabel ? getDanImageSrc(estimateLabel, estimateFamily ?? undefined) : null;

  const expectedSplit = expected ? splitExpectedLabel(expected) : { base: "", variant: "" as DanVariant };

  let matchState: "exact" | "base" | "wrong" | "unset" = "unset";
  if (expected && estimateLabel) {
    if (expected === estimateDisplay) matchState = "exact";
    else if (expectedSplit.base === estimateLabel) matchState = "base";
    else matchState = "wrong";
  }

  const tileBorder = isSelected
    ? "border-osu-pink ring-1 ring-osu-pink/40"
    : matchState === "wrong"
      ? "border-osu-red/50 hover:border-osu-red/70"
      : matchState === "base"
        ? "border-osu-yellow/40 hover:border-osu-yellow/60"
        : matchState === "exact"
          ? "border-emerald-400/40 hover:border-emerald-400/60"
          : "border-osu-b3/40 hover:border-osu-b3/70";

  return (
    <div className={`group relative flex min-w-0 flex-col overflow-hidden rounded-md border bg-osu-b5 ${tileBorder} ${isHidden ? "opacity-50" : ""} transition-colors`}>
      {coverUrl ? (
        <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30 transition-opacity group-hover:opacity-40" loading="lazy" />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-r from-osu-b5/95 via-osu-b5/75 to-osu-b5/40" />

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleHidden(beatmap.id, !isHidden);
        }}
        className={`absolute right-1 top-1 z-10 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-osu-f1 transition-all hover:bg-osu-b5/70 hover:text-white ${
          isHidden ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        title={isHidden ? "Restore diff" : "Hide diff from benchmark"}
        aria-label={isHidden ? "Restore diff" : "Hide diff from benchmark"}
      >
        {isHidden ? <RotateCcw className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </button>

      <button
        type="button"
        onClick={() => onAnalyze(beatmapset, beatmap)}
        className="relative flex min-w-0 cursor-pointer items-center gap-3 px-2.5 pt-2.5 pb-2 text-left"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center">
          {row.status === "loading" ? (
            <span className="inline-block h-5 w-5 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
          ) : row.status === "error" ? (
            <span className="text-[10px] font-bold text-osu-red" title={row.error ?? "Error"}>ERR</span>
          ) : estimateImage ? (
            <img src={estimateImage} alt="" className="h-12 w-12 object-contain drop-shadow-[0_6px_14px_rgba(0,0,0,0.55)]" />
          ) : estimateLabel ? (
            <span className="text-base font-black text-white">{estimateLabel}</span>
          ) : (
            <span className="text-osu-f1 text-[10px]">--</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-sm font-black text-white truncate">
              {row.estimate?.displayName ?? estimateLabel ?? "--"}
            </span>
            {estimateFamily ? (
              <span className="text-[9px] uppercase tracking-wide text-osu-yellow font-bold">{estimateFamily}</span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-start gap-1.5 text-[10px] text-osu-f1">
            <span className="shrink-0 tabular-nums text-osu-l2 leading-tight">&#9733;{beatmap.difficulty_rating.toFixed(2)}</span>
            <span className="min-w-0 leading-tight line-clamp-2 break-words">{beatmap.version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim()}</span>
          </div>
        </div>
      </button>

      <div className="relative flex items-center gap-1 px-2.5 pb-2">
        <select
          value={expectedSplit.base}
          onChange={(event) => {
            const nextBase = event.target.value;
            if (!nextBase) {
              onExpectedChange(beatmap.id, "");
              return;
            }
            onExpectedChange(beatmap.id, joinExpectedLabel(nextBase, expectedSplit.variant));
          }}
          onClick={(event) => event.stopPropagation()}
          className="flex-1 min-w-0 rounded border border-osu-b3/50 bg-osu-b5/80 backdrop-blur-sm px-1.5 py-0.5 text-[11px] text-osu-c1 focus:border-osu-h1/40 focus:outline-none cursor-pointer"
          title="Expected dan (base)"
        >
          <option value="">expected --</option>
          {labelOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <select
          value={expectedSplit.variant}
          onChange={(event) => {
            const nextVariant = event.target.value as DanVariant;
            if (!expectedSplit.base) return;
            onExpectedChange(beatmap.id, joinExpectedLabel(expectedSplit.base, nextVariant));
          }}
          onClick={(event) => event.stopPropagation()}
          disabled={!expectedSplit.base}
          className="w-12 shrink-0 rounded border border-osu-b3/50 bg-osu-b5/80 backdrop-blur-sm px-1 py-0.5 text-[11px] text-osu-c1 focus:border-osu-h1/40 focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-center"
          title="Expected dan (variant)"
        >
          {DAN_VARIANT_OPTIONS.map((option) => (
            <option key={option} value={option}>{option === "" ? "·" : option}</option>
          ))}
        </select>
        <span
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            matchState === "exact"
              ? "bg-emerald-500/35 text-emerald-300"
              : matchState === "base"
                ? "bg-osu-yellow/30 text-osu-yellow"
                : matchState === "wrong"
                  ? "bg-osu-red/35 text-osu-red"
                  : "text-osu-f1/30"
          }`}
          title={
            matchState === "exact"
              ? `Exact match: ${expected}`
              : matchState === "base"
                ? `Base match: expected ${expected}, got ${estimateDisplay}`
                : matchState === "wrong"
                  ? `Wrong base: expected ${expected}, got ${estimateDisplay}`
                  : "No expected dan set"
          }
        >
          {matchState === "exact" ? <Check className="h-3 w-3" strokeWidth={3} /> : matchState === "base" ? "~" : matchState === "wrong" ? "!" : ""}
        </span>
      </div>
    </div>
  );
}
