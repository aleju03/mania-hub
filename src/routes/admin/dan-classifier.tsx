import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import JSZip from "jszip";
import { Check, ClipboardList, Copy, Download, FileSpreadsheet, RotateCcw, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseManiaBeatmap } from "#/lib/beatmap-parser";
import { getDanImageSrc } from "#/lib/dan-images";
import { classifyChartWithCompanella } from "#/lib/companella";
import type { ChartClassification, DanVerdictHalf } from "#/lib/chart-classifier";
import { canUseAdminFeatures, canUseDevFeatures } from "#/lib/auth-shared";
import {
  type DanBenchmarkFamily,
  getBenchmarkBeatmapIds,
  getBenchmarkBeatmapsetIds,
  getBenchmarkBeatmapStarRating,
  getBenchmarkExpectedLabelOverride,
  getBenchmarkLabelOptions,
} from "#/lib/dan-benchmark-sets";
import { getDanBenchmarkHiddenDiffs, getDanBenchmarkLabels, setDanBenchmarkHiddenDiff, setDanBenchmarkLabel } from "#/lib/dan-benchmark";
import {
  getDanClassifierChartBatch,
  getDanClassifierChartFile,
  getDanClassifierSets,
} from "#/lib/dan-classifier-admin";
import type { DanClassifierSetMeta } from "#/lib/dan-classifier-admin";
import { fetchLiveMapSearch } from "#/lib/live-backend";
import type { LiveMapSearchEntry } from "#/lib/live-backend";

type PreferFamily = "rc" | "ln" | "auto";

const VERDICT_SOURCE_LABELS: Record<DanVerdictHalf["source"], string> = {
  "leoblack-mixed": "LeoBlack Mixed",
  "leoblack-companella": "Companella",
  "leoblack-sunny-table": "Sunny table",
  "inhouse-ln-knn": "LN kNN",
};

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

function cleanVersionLabel(version: string): string {
  return version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim();
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

// setTimeout is throttled to 1s+ in background tabs, which would crawl the
// benchmark loop when the tab loses focus; MessageChannel messages are not.
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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
  title: string;
  version: string;
  sr: number;
  srProxy: number | null;
  rawDan: number | null;
  confidence: number | null;
  expectedDan: string | null;
  detectedDan: string | null;
  detectedFamily: string | null;
  match: boolean | null;
}

type BenchmarkExportDataset = Record<DanBenchmarkFamily, BenchmarkExportRow[]>;

type BenchmarkExportColumnKey = Exclude<keyof BenchmarkExportRow, "family">;

interface BenchmarkExportColumn {
  key: BenchmarkExportColumnKey;
  label: string;
  width: number;
  type?: "number";
}

const BENCHMARK_EXPORT_FAMILIES: DanBenchmarkFamily[] = ["normal", "ln", "ranked"];

const BENCHMARK_EXPORT_COLUMNS: BenchmarkExportColumn[] = [
  { key: "beatmapsetId", label: "Beatmapset ID", width: 90, type: "number" },
  { key: "beatmapId", label: "Beatmap ID", width: 85, type: "number" },
  { key: "title", label: "Title", width: 190 },
  { key: "version", label: "Difficulty", width: 220 },
  { key: "sr", label: "SR", width: 55, type: "number" },
  { key: "srProxy", label: "SR Proxy", width: 75, type: "number" },
  { key: "rawDan", label: "Raw Dan", width: 75, type: "number" },
  { key: "confidence", label: "Confidence", width: 82, type: "number" },
  { key: "expectedDan", label: "Expected Dan", width: 95 },
  { key: "detectedDan", label: "Detected Dan", width: 95 },
  { key: "detectedFamily", label: "Detected Family", width: 105 },
  { key: "match", label: "Match", width: 65 },
];

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function formatBenchmarkFamily(family: DanBenchmarkFamily): string {
  if (family === "ln") return "LN";
  if (family === "ranked") return "Ranked";
  return "Normal";
}

function getBenchmarkExportCellValue(row: BenchmarkExportRow, key: BenchmarkExportColumnKey): string | number {
  if (key === "match") {
    return row.match == null ? "" : row.match ? "yes" : "no";
  }
  if (key === "sr") {
    return Number(row.sr.toFixed(2));
  }
  if (key === "srProxy") {
    return row.srProxy == null ? "" : Number(row.srProxy.toFixed(2));
  }
  if (key === "rawDan") {
    return row.rawDan == null ? "" : Number(row.rawDan.toFixed(2));
  }
  if (key === "confidence") {
    return row.confidence == null ? "" : Number(row.confidence.toFixed(2));
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

interface AnalyzeTarget {
  beatmapId: number;
  title: string | null;
  artist: string | null;
  version: string | null;
  starRating: number | null;
  preferFamily: PreferFamily;
}

interface SelectedChartState {
  target: AnalyzeTarget;
  status: "loading" | "not-cached" | "ready" | "error";
  classification: ChartClassification | null;
  osuText: string | null;
  rateUsed: number;
  title: string | null;
  artist: string | null;
  version: string | null;
  error: string | null;
}

type SearchResults =
  | {
      kind: "sets";
      sets: DanClassifierSetMeta[];
      missingBeatmapsetId: number | null;
      missingBeatmapId: number | null;
    }
  | { kind: "text"; items: LiveMapSearchEntry[]; total: number };

export const Route = createFileRoute("/admin/dan-classifier")({
  head: () => ({
    meta: [
      { title: "Pattern Analyzer - dev" },
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
  const { auth } = Route.useRouteContext();
  const canUseBenchmark = canUseAdminFeatures(auth);
  const [view, setView] = useState<"search" | "benchmark">("search");
  const [benchmarkFamily, setBenchmarkFamily] = useState<DanBenchmarkFamily>("normal");
  const [query, setQuery] = useState("");
  const [rate, setRate] = useState(1);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedChartState | null>(null);
  const [copiedBeatmapId, setCopiedBeatmapId] = useState<number | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRequestRef = useRef(0);
  const analyzeRequestRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    const trimmed = query.trim();
    clearTimeout(searchTimerRef.current);
    if (trimmed.length < 2) {
      setResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    setSearchLoading(true);
    setSearchError(null);
    const requestId = ++searchRequestRef.current;
    searchTimerRef.current = setTimeout(async () => {
      try {
        const beatmapsetId = extractBeatmapsetId(trimmed);
        const beatmapId = extractBeatmapId(trimmed);
        if (beatmapsetId != null || beatmapId != null) {
          const result = await getDanClassifierSets({
            data: {
              beatmapsetIds: beatmapsetId != null ? [beatmapsetId] : [],
              beatmapIds: beatmapId != null ? [beatmapId] : [],
            },
          });
          if (searchRequestRef.current !== requestId) return;
          const seenSetIds = new Set<number>();
          const sets: DanClassifierSetMeta[] = [];
          for (const set of result.sets) {
            if (seenSetIds.has(set.beatmapsetId)) continue;
            seenSetIds.add(set.beatmapsetId);
            sets.push(set);
          }
          setResults({
            kind: "sets",
            sets,
            missingBeatmapsetId: sets.length === 0 && beatmapsetId != null && result.missingBeatmapsetIds.includes(beatmapsetId)
              ? beatmapsetId
              : null,
            missingBeatmapId: sets.length === 0 && beatmapId != null && result.missingBeatmapIds.includes(beatmapId)
              ? beatmapId
              : null,
          });
        } else {
          const result = await fetchLiveMapSearch({
            q: trimmed,
            keys: [],
            keysExclude: [],
            statuses: [],
            statusesExclude: [],
            patterns: [],
            patternsExclude: [],
            starMin: null,
            starMax: null,
            bpmMin: null,
            bpmMax: null,
            lenMin: null,
            lenMax: null,
            danMin: null,
            danMax: null,
            country: null,
            sort: "relevance",
            dir: "desc",
            page: 0,
            pageSize: 12,
          });
          if (searchRequestRef.current !== requestId) return;
          setResults({ kind: "text", items: result.items, total: result.total });
        }
      } catch (err) {
        if (searchRequestRef.current !== requestId) return;
        setSearchError(err instanceof Error ? err.message : "Could not search the local catalog.");
      } finally {
        if (searchRequestRef.current === requestId) setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(searchTimerRef.current);
  }, [query]);

  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  useEffect(() => {
    if (!canUseBenchmark && view === "benchmark") {
      setView("search");
    }
  }, [canUseBenchmark, view]);

  const analyzeTarget = useCallback(async (target: AnalyzeTarget, allowOsuFetch = false) => {
    const requestId = ++analyzeRequestRef.current;
    const rateUsed = rateRef.current;
    setSelected({
      target,
      status: "loading",
      classification: null,
      osuText: null,
      rateUsed,
      title: target.title,
      artist: target.artist,
      version: target.version,
      error: null,
    });

    try {
      const file = await getDanClassifierChartFile({ data: { beatmapId: target.beatmapId, allowOsuFetch } });
      if (analyzeRequestRef.current !== requestId) return;
      if (file.notCached || file.content == null) {
        setSelected((prev) => (
          prev && prev.target.beatmapId === target.beatmapId ? { ...prev, status: "not-cached" } : prev
        ));
        return;
      }
      // let the spinner paint before the classify
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (analyzeRequestRef.current !== requestId) return;
      const map = parseManiaBeatmap(file.content);
      const classification = await classifyChartWithCompanella(map, file.content, {
        rate: rateUsed,
        starRating: target.starRating ?? 0,
        title: map.title,
        version: map.version,
        preferFamily: target.preferFamily,
      });
      if (analyzeRequestRef.current !== requestId) return;
      setSelected({
        target,
        status: "ready",
        classification,
        osuText: file.content,
        rateUsed,
        title: target.title ?? map.title,
        artist: target.artist ?? map.artist,
        version: target.version ?? map.version,
        error: null,
      });
    } catch (err) {
      if (analyzeRequestRef.current !== requestId) return;
      setSelected((prev) => (
        prev && prev.target.beatmapId === target.beatmapId
          ? { ...prev, status: "error", error: err instanceof Error ? err.message : "Could not analyze this chart." }
          : prev
      ));
    }
  }, []);

  const copyBeatmapId = useCallback(async (beatmapId: number) => {
    const copied = await copyTextToClipboard(String(beatmapId));
    if (!copied) return;

    setCopiedBeatmapId(beatmapId);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedBeatmapId(null), 1200);
  }, []);

  const selectedBeatmapId = selected?.target.beatmapId ?? null;

  return (
    <main className="min-h-screen overflow-x-clip bg-osu-b5 text-osu-c1">
      <div className="max-w-[1200px] mx-auto px-4 py-7 sm:px-5 sm:py-10">
        <div className="pb-6 border-b border-osu-b3/30">
          <div className="text-[11px] uppercase tracking-[0.16em] text-osu-yellow font-bold">
            Admin
          </div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white">
            Pattern Analyzer
          </h1>
          <div className="mt-2 text-sm text-osu-f1">
            Search the local map catalog and classify chart patterns and dan verdicts. Chart files come from the live backend; osu! is only fetched on explicit request.
          </div>
        </div>

        <div className="mt-5 flex items-center gap-1 border-b border-osu-b3/30">
          <ViewTab active={view === "search"} onClick={() => setView("search")}>Search</ViewTab>
          {canUseBenchmark ? (
            <ViewTab active={view === "benchmark"} onClick={() => setView("benchmark")}>Benchmark</ViewTab>
          ) : null}
        </div>

        <div
          className={`mt-6 grid min-w-0 gap-6 items-start ${
            view === "benchmark" && !selected
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
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search beatmap, or paste a link or id..."
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

            {searchError && (
              <div className="mt-4 rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3 text-sm text-osu-red">
                {searchError}
              </div>
            )}

            <div className="mt-5 space-y-3">
              {results?.kind === "sets" ? (
                <>
                  {(results.missingBeatmapsetId != null || results.missingBeatmapId != null) && (
                    <div className="rounded-lg border border-osu-b3/30 bg-osu-b5/60 px-4 py-3">
                      <div className="text-sm text-osu-f1">
                        {results.missingBeatmapsetId != null && results.missingBeatmapId != null
                          ? `#${results.missingBeatmapId} is not in the local DB as a beatmap or beatmapset.`
                          : results.missingBeatmapsetId != null
                            ? `Beatmapset #${results.missingBeatmapsetId} is not in the local DB.`
                            : `Beatmap #${results.missingBeatmapId} is not in the local DB.`}
                      </div>
                      {results.missingBeatmapId != null && (
                        <button
                          type="button"
                          onClick={() => void analyzeTarget({
                            beatmapId: results.missingBeatmapId as number,
                            title: null,
                            artist: null,
                            version: null,
                            starRating: null,
                            preferFamily: "auto",
                          }, true)}
                          className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-md border border-osu-pink/30 bg-osu-pink/20 px-3 py-1.5 text-[11px] font-black text-white transition-colors hover:border-osu-pink/60 hover:bg-osu-pink/30"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Analyze via osu! fetch
                        </button>
                      )}
                    </div>
                  )}

                  {results.sets.map((set) => {
                    const maniaDiffs = set.diffs
                      .filter((diff) => diff.mode === "mania")
                      .sort((a, b) => (a.keyCount ?? 0) - (b.keyCount ?? 0) || (a.starRating ?? 0) - (b.starRating ?? 0));

                    return (
                      <div key={set.beatmapsetId} className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b5 p-4">
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-black text-white truncate">{set.title ?? `Set #${set.beatmapsetId}`}</div>
                            <div className="mt-1 text-[11px] text-osu-f1 truncate">{set.artist ?? "Unknown artist"}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void copyBeatmapId(set.beatmapsetId)}
                              className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-osu-b3/40 bg-osu-b4/40 text-osu-l2 transition-colors hover:border-osu-l2/40 hover:text-white"
                              title={`Copy beatmapset ID ${set.beatmapsetId}`}
                              aria-label={`Copy beatmapset ID ${set.beatmapsetId}`}
                            >
                              {copiedBeatmapId === set.beatmapsetId ? (
                                <Check className="h-3.5 w-3.5" strokeWidth={3} />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <a
                              href={`https://osu.ppy.sh/beatmapsets/${set.beatmapsetId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] font-bold text-osu-l2 hover:text-white transition-colors"
                            >
                              osu!
                            </a>
                          </div>
                        </div>

                        <div className="mt-3 flex min-w-0 flex-wrap gap-1.5 overflow-hidden">
                          {maniaDiffs.map((diff) => (
                            <button
                              key={diff.beatmapId}
                              type="button"
                              onClick={() => void analyzeTarget({
                                beatmapId: diff.beatmapId,
                                title: set.title,
                                artist: set.artist,
                                version: diff.version,
                                starRating: diff.starRating,
                                preferFamily: "auto",
                              })}
                              title={diff.cached ? undefined : "Chart not cached in local DB"}
                              className={`inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden px-2.5 py-1 rounded-md text-left text-[11px] cursor-pointer transition-colors border ${
                                selectedBeatmapId === diff.beatmapId
                                  ? "bg-osu-pink/30 border-osu-pink/60 text-white"
                                  : "bg-osu-b4/50 hover:bg-osu-b4 text-osu-c1"
                              } ${diff.cached ? "border-osu-b3/40" : "border-dashed border-osu-b3/60"}`}
                            >
                              <span className="shrink-0 text-osu-yellow font-semibold">{diff.keyCount != null ? `${diff.keyCount}K` : "?K"}</span>
                              <span className="min-w-0 truncate">{cleanVersionLabel(diff.version)}</span>
                              {diff.starRating != null ? (
                                <span className="shrink-0 text-osu-l2">&#9733;{diff.starRating.toFixed(2)}</span>
                              ) : null}
                            </button>
                          ))}
                          {maniaDiffs.length === 0 ? (
                            <div className="text-[11px] text-osu-f1">No mania diffs in the local DB for this set.</div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : results?.kind === "text" ? (
                <>
                  {results.items.map((item) => {
                    const diffs = item.diffs && item.diffs.length > 0 ? item.diffs : [item];
                    const coverUrl = item.covers?.["cover@2x"] || item.covers?.cover || null;

                    return (
                      <div key={item.beatmapsetId} className="relative min-w-0 overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b5">
                        {coverUrl && (
                          <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" loading="lazy" />
                        )}
                        <div className="absolute inset-0 bg-osu-b5/80" />
                        <div className="relative p-4">
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-black text-white truncate">{item.title}</div>
                              <div className="mt-1 text-[11px] text-osu-f1 truncate">
                                {item.artist} // {item.creator} // {item.status}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void copyBeatmapId(item.beatmapsetId)}
                                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-black/35 text-osu-l2 transition-colors hover:border-osu-l2/40 hover:bg-black/55 hover:text-white"
                                title={`Copy beatmapset ID ${item.beatmapsetId}`}
                                aria-label={`Copy beatmapset ID ${item.beatmapsetId}`}
                              >
                                {copiedBeatmapId === item.beatmapsetId ? (
                                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <a
                                href={`https://osu.ppy.sh/beatmapsets/${item.beatmapsetId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-bold text-osu-l2 hover:text-white transition-colors"
                              >
                                osu!
                              </a>
                            </div>
                          </div>

                          <div className="mt-3 flex min-w-0 flex-wrap gap-1.5 overflow-hidden">
                            {diffs.map((diff) => (
                              <button
                                key={diff.beatmapId}
                                type="button"
                                onClick={() => void analyzeTarget({
                                  beatmapId: diff.beatmapId,
                                  title: item.title,
                                  artist: item.artist,
                                  version: diff.version,
                                  starRating: diff.stars,
                                  preferFamily: "auto",
                                })}
                                className={`inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden px-2.5 py-1 rounded-md text-left text-[11px] cursor-pointer transition-colors border ${
                                  selectedBeatmapId === diff.beatmapId
                                    ? "bg-osu-pink/30 border-osu-pink/60 text-white"
                                    : "bg-black/40 hover:bg-black/60 border-white/10 text-white/90"
                                }`}
                              >
                                <span className="shrink-0 text-osu-yellow font-semibold">{diff.keyCount}K</span>
                                <span className="min-w-0 truncate">{cleanVersionLabel(diff.version)}</span>
                                <span className="shrink-0 text-osu-l2">&#9733;{diff.stars.toFixed(2)}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {!searchLoading && results.items.length === 0 && (
                    <div className="py-12 text-center text-sm text-osu-f1">No maps in the local catalog match this search.</div>
                  )}
                </>
              ) : null}

              {query.trim().length < 2 && (
                <div className="py-12 text-center text-sm text-osu-f1">
                  Type to search the local catalog, or paste a beatmap link or id.
                </div>
              )}
            </div>
          </section>
          ) : (
            <BenchmarkView
              family={benchmarkFamily}
              onFamilyChange={setBenchmarkFamily}
              rate={rate}
              onRateChange={setRate}
              selectedBeatmapId={selectedBeatmapId}
              onAnalyze={analyzeTarget}
              onCopyId={copyBeatmapId}
              copiedBeatmapId={copiedBeatmapId}
            />
          )}

          {!(view === "benchmark" && !selected) && (
          <aside className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4 sm:p-5 lg:sticky lg:top-24">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">
                  Analysis
                </div>
                <div className="mt-1 text-[11px] font-bold text-osu-yellow">
                  unified classifier
                </div>
              </div>
              {view === "benchmark" && selected ? (
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="cursor-pointer rounded-md border border-osu-b3/40 bg-osu-b5/60 px-2 py-1 text-[10px] text-osu-f1 hover:text-white hover:border-osu-b3 transition-colors"
                  title="Close detail"
                >
                  Close
                </button>
              ) : null}
            </div>
            <AnalysisPanel
              selected={selected}
              onFetchFromOsu={(target) => void analyzeTarget(target, true)}
            />
          </aside>
          )}
        </div>
      </div>
    </main>
  );
}

interface AnalysisPanelProps {
  selected: SelectedChartState | null;
  onFetchFromOsu: (target: AnalyzeTarget) => void;
}

function AnalysisPanel({ selected, onFetchFromOsu }: AnalysisPanelProps) {
  if (!selected) {
    return (
      <div className="mt-8 py-10 text-center text-sm text-osu-f1">
        Pick a difficulty to classify it.
      </div>
    );
  }

  const heading = selected.title
    ? `${selected.artist ? `${selected.artist} - ` : ""}${selected.title}${selected.version ? ` [${selected.version}]` : ""}`
    : `Beatmap #${selected.target.beatmapId}`;

  if (selected.status === "loading") {
    return (
      <div className="mt-8 flex flex-col items-center gap-3 py-10">
        <div className="w-7 h-7 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
        <div className="text-sm text-osu-f1">Classifying chart...</div>
      </div>
    );
  }

  if (selected.status === "not-cached") {
    return (
      <div className="mt-4 min-w-0">
        <div className="text-sm text-osu-f1 break-words">{heading}</div>
        <div className="mt-5 rounded-lg border border-osu-b3/40 bg-osu-b5/60 px-4 py-5 text-center">
          <div className="text-sm font-bold text-osu-c1">Not cached</div>
          <div className="mt-1 text-[11px] text-osu-f1">
            This chart is not in the local DB. Fetching hits the osu! API once.
          </div>
          <button
            type="button"
            onClick={() => onFetchFromOsu(selected.target)}
            className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-md border border-osu-pink/30 bg-osu-pink/20 px-3 py-2 text-xs font-black text-white transition-colors hover:border-osu-pink/60 hover:bg-osu-pink/30"
          >
            <Download className="h-4 w-4" />
            Fetch from osu!
          </button>
        </div>
      </div>
    );
  }

  if (selected.status === "error") {
    return (
      <div className="mt-4 min-w-0">
        <div className="text-sm text-osu-f1 break-words">{heading}</div>
        <div className="mt-4 rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3 text-sm text-osu-red">
          {selected.error ?? "Could not analyze this chart."}
        </div>
      </div>
    );
  }

  const classification = selected.classification;
  if (!classification) return null;
  const primary = classification.primary;
  const halves = [classification.rc, classification.ln].filter((half): half is DanVerdictHalf => half != null);
  const report = classification.clusters?.report ?? null;

  return (
    <div className="mt-4 min-w-0">
      <div className="text-sm text-osu-f1 break-words">{heading}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-osu-f1">
        <span className="rounded border border-osu-b3/40 bg-osu-b5 px-1.5 py-0.5 font-bold text-osu-yellow">
          {classification.keyCount}K
        </span>
        {selected.target.starRating != null ? (
          <span className="tabular-nums text-osu-l2">&#9733;{selected.target.starRating.toFixed(2)}</span>
        ) : null}
        <span className="tabular-nums">{selected.rateUsed.toFixed(2)}x</span>
      </div>

      {primary ? (
        <div className="mt-4 flex items-center gap-4">
          {getDanImageSrc(primary.label, primary.kind === "ln" ? "ln" : undefined, classification.keyCount) ? (
            <img
              src={getDanImageSrc(primary.label, primary.kind === "ln" ? "ln" : undefined, classification.keyCount) ?? undefined}
              alt=""
              className="h-16 w-16 shrink-0 object-contain drop-shadow-[0_10px_24px_rgba(0,0,0,0.45)] sm:h-20 sm:w-20"
            />
          ) : null}
          <div className="min-w-0">
            <div className="truncate text-3xl font-black leading-none text-white sm:text-4xl">{primary.displayName}</div>
            <div className="mt-2 text-sm font-bold text-osu-yellow">
              {primary.kind === "ln" ? "LN dan" : "RC dan"}
              <span className="ml-2 font-normal text-osu-f1">{Math.round(primary.confidence * 100)}% confidence</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 text-sm text-osu-f1">
          {[4, 6, 7].includes(classification.keyCount)
            ? "No dan verdict for this chart."
            : "No dan verdict: dan tables only exist for 4K, 6K, and 7K. Patterns below still apply."}
        </div>
      )}

      {halves.length > 0 ? (
        <div className="mt-4 space-y-1.5">
          {halves.map((half) => (
            <VerdictHalfRow key={half.kind} half={half} />
          ))}
        </div>
      ) : null}

      {classification.vibro ? (
        <div className="mt-3 inline-flex items-center rounded border border-osu-yellow/30 bg-osu-yellow/10 px-2 py-1 text-[11px] font-bold text-osu-yellow">
          vibro detected - RC verdict inflated
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
        <Metric label="Sunny SR" value={classification.sunnySr != null ? classification.sunnySr.toFixed(2) : "--"} />
        <Metric label="LN ratio" value={`${Math.round(classification.lnRatio * 100)}%`} />
        {report ? <Metric label="Category" value={report.Category} /> : null}
        {report ? <Metric label="Mode" value={report.ModeTag} /> : null}
        {report && report.SVAmount > 0 ? <Metric label="SVs" value={String(report.SVAmount)} /> : null}
      </div>

      {classification.clusters && classification.clusters.topFiveClusters.length > 0 ? (
        <div className="mt-5">
          <div className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold">Clusters</div>
          <div className="mt-2 space-y-1.5">
            {classification.clusters.topFiveClusters.map((cluster, index) => {
              const duration = classification.clusters?.report.Duration ?? 0;
              const share = duration > 0 ? Math.min(100, (cluster.Amount / duration) * 100) : 0;
              return (
                <div key={index} className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="min-w-0 truncate text-osu-c1">{cluster.format(selected.rateUsed)}</span>
                  <span className="shrink-0 tabular-nums text-osu-f1">{share.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {selected.osuText != null && [4, 6, 7].includes(classification.keyCount) ? (
        <MsdSection
          beatmapId={selected.target.beatmapId}
          osuText={selected.osuText}
          keyCount={classification.keyCount}
          rate={selected.rateUsed}
        />
      ) : null}

      {classification.warnings.length > 0 ? (
        <ul className="mt-5 space-y-1 text-[11px] text-osu-f1/80">
          {classification.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {classification.verdictText ? (
        <div className="mt-4 break-words font-mono text-[10px] text-osu-f1/70">{classification.verdictText}</div>
      ) : null}

      <Link
        to="/replay"
        search={{ tab: "beatmap" }}
        className="mt-5 block text-center px-3 py-2 rounded-lg bg-osu-b5 text-[11px] font-bold text-osu-l2 border border-osu-b3/40 hover:text-white hover:border-osu-b3 transition-colors"
      >
        Find replays for this map
      </Link>
    </div>
  );
}

const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"] as const;

interface MsdSectionState {
  status: "loading" | "ready" | "error";
  values: Record<string, number> | null;
  version: string | null;
  error: string | null;
}

function MsdSection({ beatmapId, osuText, keyCount, rate }: {
  beatmapId: number;
  osuText: string;
  keyCount: number;
  rate: number;
}) {
  const [state, setState] = useState<MsdSectionState>({ status: "loading", values: null, version: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", values: null, version: null, error: null });
    (async () => {
      try {
        const { analyzeEtternaFromText } = await import("#/lib/leoblack/ett/index.js");
        const result = await analyzeEtternaFromText(osuText, { musicRate: rate, keyOverride: keyCount });
        if (cancelled) return;
        setState({ status: "ready", values: result.values, version: result.etternaVersion ?? null, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          values: null,
          version: null,
          error: err instanceof Error ? err.message : "MSD calculation failed.",
        });
      }
    })();
    return () => { cancelled = true; };
  }, [beatmapId, osuText, keyCount, rate]);

  const rows = state.values
    ? MSD_SKILLSETS
        .map((name) => ({ name, value: state.values?.[name] ?? 0 }))
        .sort((a, b) => b.value - a.value)
    : [];
  const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0);

  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold">MSD</div>
        {state.version ? (
          <span className="text-[10px] text-osu-f1/70">MinaCalc {state.version}</span>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <div className="mt-2 text-[11px] text-osu-f1/70">calculating...</div>
      ) : null}
      {state.status === "error" ? (
        <div className="mt-2 text-[11px] text-osu-f1/70">{state.error}</div>
      ) : null}
      {state.status === "ready" && state.values ? (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-3 text-[12px] font-bold text-osu-c1">
            <span>Overall</span>
            <span className="tabular-nums">{(state.values.Overall ?? 0).toFixed(2)}</span>
          </div>
          <div className="mt-2 space-y-2">
            {rows.map((row) => (
              <div key={row.name}>
                <div className="flex justify-between gap-3 text-[11px] font-bold text-osu-f1">
                  <span>{row.name}</span>
                  <span className="tabular-nums">{row.value.toFixed(2)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-osu-b5">
                  <div
                    className="h-full rounded-full bg-osu-pink"
                    style={{ width: `${maxValue > 0 ? Math.max(4, (row.value / maxValue) * 100) : 4}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function VerdictHalfRow({ half }: { half: DanVerdictHalf }) {
  return (
    <div className="rounded-md border border-osu-b3/30 bg-osu-b5 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        <span className="w-6 shrink-0 font-bold uppercase tracking-wide text-osu-yellow">{half.kind}</span>
        <span className="min-w-0 truncate font-black text-white">{half.displayName}</span>
        <span className="shrink-0 rounded border border-osu-b3/40 bg-osu-b4/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-osu-f1">
          {VERDICT_SOURCE_LABELS[half.source]}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-osu-f1">raw {half.rawDan.toFixed(2)}</span>
      </div>
      {half.boundary ? (
        <div className="mt-1 text-[10px] text-osu-f1/80">
          {half.boundary === "below" ? "below table range" : "above table range"}
        </div>
      ) : null}
    </div>
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

type BenchmarkRowStatus = "pending" | "classifying" | "ready" | "not-cached" | "error";

interface BenchmarkRow {
  beatmapId: number;
  beatmapsetId: number;
  version: string;
  starRating: number;
  content: string | null;
  classification: ChartClassification | null;
  status: BenchmarkRowStatus;
  error: string | null;
}

interface BenchmarkSetState {
  beatmapsetId: number;
  title: string;
  artist: string | null;
  rows: BenchmarkRow[];
}

interface BenchmarkFamilyState {
  sets: BenchmarkSetState[];
  missingIds: number[];
  contentsLoaded: boolean;
  classifiedAtRate: number | null;
}

// Metadata for one benchmark family from the live backend's local projections.
async function loadBenchmarkFamilyMeta(family: DanBenchmarkFamily): Promise<BenchmarkFamilyState> {
  const rankedIds = getBenchmarkBeatmapIds(family);
  const setOrder = getBenchmarkBeatmapsetIds(family);
  const result = family === "ranked"
    ? await getDanClassifierSets({ data: { beatmapIds: [...(rankedIds ?? new Set<number>())] } })
    : await getDanClassifierSets({ data: { beatmapsetIds: setOrder } });

  const orderIndex = new Map(setOrder.map((id, index) => [id, index]));
  const sets: BenchmarkSetState[] = result.sets
    .map((set) => ({
      beatmapsetId: set.beatmapsetId,
      title: set.title ?? `Set #${set.beatmapsetId}`,
      artist: set.artist,
      rows: set.diffs
        .filter((diff) => diff.mode === "mania" && diff.keyCount === 4)
        .filter((diff) => !rankedIds || rankedIds.has(diff.beatmapId))
        .map((diff): BenchmarkRow => ({
          beatmapId: diff.beatmapId,
          beatmapsetId: diff.beatmapsetId,
          version: diff.version,
          starRating: diff.starRating ?? getBenchmarkBeatmapStarRating(diff.beatmapId) ?? 0,
          content: null,
          classification: null,
          status: diff.cached ? "pending" : "not-cached",
          error: null,
        }))
        .sort((a, b) => a.starRating - b.starRating),
    }))
    .sort((a, b) => (orderIndex.get(a.beatmapsetId) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.beatmapsetId) ?? Number.MAX_SAFE_INTEGER));

  const missingIds = family === "ranked" ? result.missingBeatmapIds : result.missingBeatmapsetIds;
  return { sets, missingIds, contentsLoaded: false, classifiedAtRate: null };
}

interface BenchmarkViewProps {
  family: DanBenchmarkFamily;
  onFamilyChange: (family: DanBenchmarkFamily) => void;
  rate: number;
  onRateChange: (rate: number) => void;
  selectedBeatmapId: number | null;
  onAnalyze: (target: AnalyzeTarget) => void;
  onCopyId: (id: number) => void;
  copiedBeatmapId: number | null;
}

function BenchmarkView({
  family,
  onFamilyChange,
  rate,
  onRateChange,
  selectedBeatmapId,
  onAnalyze,
  onCopyId,
  copiedBeatmapId,
}: BenchmarkViewProps) {
  // family-keyed cache so switching tabs doesn't re-fetch metadata or chart texts
  const cacheRef = useRef<Map<DanBenchmarkFamily, BenchmarkFamilyState>>(new Map());
  const familyRef = useRef(family);
  familyRef.current = family;
  const [familyState, setFamilyState] = useState<BenchmarkFamilyState | null>(null);
  const [chartsProgress, setChartsProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [expectedLabelsByFamily, setExpectedLabelsByFamily] = useState<Record<DanBenchmarkFamily, Map<number, string>>>({
    normal: new Map(),
    ln: new Map(),
    ranked: new Map(),
  });
  const [hiddenByFamily, setHiddenByFamily] = useState<Record<DanBenchmarkFamily, Set<number>>>({
    normal: new Set(),
    ln: new Set(),
    ranked: new Set(),
  });
  const [labelsLoaded, setLabelsLoaded] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [exportState, setExportState] = useState<BenchmarkExportState>({ action: null, status: "idle" });
  const [fetchMissingProgress, setFetchMissingProgress] = useState<{ done: number; total: number } | null>(null);
  const fetchMissingBusyRef = useRef(false);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const expectedLabels = expectedLabelsByFamily[family];
  const hiddenSet = hiddenByFamily[family];
  const labelOptions = useMemo(() => getBenchmarkLabelOptions(family), [family]);

  const commitFamilyState = useCallback((fam: DanBenchmarkFamily, next: BenchmarkFamilyState) => {
    cacheRef.current.set(fam, next);
    if (familyRef.current === fam) setFamilyState(next);
  }, []);

  const patchRows = useCallback((fam: DanBenchmarkFamily, patches: Map<number, Partial<BenchmarkRow>>) => {
    const current = cacheRef.current.get(fam);
    if (!current || patches.size === 0) return;
    let changedAny = false;
    const sets = current.sets.map((set) => {
      let changed = false;
      const rows = set.rows.map((row) => {
        const patch = patches.get(row.beatmapId);
        if (!patch) return row;
        changed = true;
        return { ...row, ...patch };
      });
      if (!changed) return set;
      changedAny = true;
      return { ...set, rows };
    });
    if (!changedAny) return;
    commitFamilyState(fam, { ...current, sets });
  }, [commitFamilyState]);

  // load expected labels + hidden diffs for every family once
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [normalRows, lnRows, rankedRows, normalHidden, lnHidden, rankedHidden] = await Promise.all([
          getDanBenchmarkLabels({ data: { family: "normal" } }),
          getDanBenchmarkLabels({ data: { family: "ln" } }),
          getDanBenchmarkLabels({ data: { family: "ranked" } }),
          getDanBenchmarkHiddenDiffs({ data: { family: "normal" } }),
          getDanBenchmarkHiddenDiffs({ data: { family: "ln" } }),
          getDanBenchmarkHiddenDiffs({ data: { family: "ranked" } }),
        ]);
        if (cancelled) return;
        const normalMap = new Map<number, string>();
        for (const row of normalRows) normalMap.set(row.beatmapId, row.expectedLabel);
        const lnMap = new Map<number, string>();
        for (const row of lnRows) lnMap.set(row.beatmapId, row.expectedLabel);
        const rankedMap = new Map<number, string>();
        for (const row of rankedRows) rankedMap.set(row.beatmapId, row.expectedLabel);
        setExpectedLabelsByFamily({ normal: normalMap, ln: lnMap, ranked: rankedMap });
        setHiddenByFamily({ normal: new Set(normalHidden), ln: new Set(lnHidden), ranked: new Set(rankedHidden) });
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

  // load metadata + cached chart texts, then classify client-side.
  // Chart texts come from the live backend's local DB; nothing here hits osu!.
  useEffect(() => {
    let cancelled = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let queuedPatches = new Map<number, Partial<BenchmarkRow>>();

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (queuedPatches.size === 0) return;
      const patches = queuedPatches;
      queuedPatches = new Map();
      patchRows(family, patches);
    };
    const queuePatch = (beatmapId: number, patch: Partial<BenchmarkRow>) => {
      queuedPatches.set(beatmapId, { ...(queuedPatches.get(beatmapId) ?? {}), ...patch });
      if (!flushTimer) flushTimer = setTimeout(flush, 80);
    };

    void run();

    async function run() {
      let cache = cacheRef.current.get(family) ?? null;
      if (cache) {
        setFamilyState(cache);
        setMetaError(null);
      } else {
        setFamilyState(null);
        setMetaLoading(true);
        setMetaError(null);
        try {
          cache = await loadBenchmarkFamilyMeta(family);
        } catch (err) {
          if (!cancelled) {
            setMetaError(err instanceof Error ? err.message : "Could not load benchmark metadata.");
            setMetaLoading(false);
          }
          return;
        }
        if (cancelled) return;
        setMetaLoading(false);
        commitFamilyState(family, cache);
      }

      if (!cache.contentsLoaded) {
        const allIds = cache.sets.flatMap((set) => set.rows.map((row) => row.beatmapId));
        setChartsProgress({ loaded: 0, total: allIds.length });
        let loadedCharts = 0;
        await Promise.all(chunkArray(allIds, 50).map(async (chunk) => {
          try {
            const batch = await withTimeout(
              getDanClassifierChartBatch({ data: { ids: chunk } }),
              30_000,
              "Chart batch",
            );
            if (cancelled) return;
            const patches = new Map<number, Partial<BenchmarkRow>>();
            for (const file of batch.files) {
              patches.set(file.beatmapId, { content: file.content, status: "pending", error: null });
            }
            for (const beatmapId of batch.missing) {
              patches.set(beatmapId, { content: null, status: "not-cached", error: null });
            }
            patchRows(family, patches);
          } catch (err) {
            if (cancelled) return;
            const message = err instanceof Error ? err.message : "Chart batch failed.";
            const patches = new Map<number, Partial<BenchmarkRow>>();
            for (const beatmapId of chunk) patches.set(beatmapId, { status: "error", error: message });
            patchRows(family, patches);
          } finally {
            loadedCharts += chunk.length;
            if (!cancelled) setChartsProgress({ loaded: loadedCharts, total: allIds.length });
          }
        }));
        setChartsProgress(null);
        const loaded = cacheRef.current.get(family);
        if (!loaded || cancelled) return;
        commitFamilyState(family, { ...loaded, contentsLoaded: true });
      }

      const current = cacheRef.current.get(family);
      if (!current || cancelled) return;
      if (current.classifiedAtRate === rate) return;

      const targets: BenchmarkRow[] = [];
      const resetPatches = new Map<number, Partial<BenchmarkRow>>();
      for (const set of current.sets) {
        for (const row of set.rows) {
          if (row.content == null) continue;
          targets.push(row);
          resetPatches.set(row.beatmapId, { status: "classifying", classification: null, error: null });
        }
      }
      patchRows(family, resetPatches);

      const preferFamily: PreferFamily = family === "ln" ? "ln" : "rc";
      for (const row of targets) {
        if (cancelled) return;
        // classification can take a few hundred ms (longer when Companella runs); yield between charts
        await yieldToUi();
        if (cancelled) return;
        const content = row.content;
        if (content == null) continue;
        try {
          const map = parseManiaBeatmap(content);
          const classification = await classifyChartWithCompanella(map, content, {
            rate,
            starRating: row.starRating,
            title: map.title,
            version: map.version,
            preferFamily,
          });
          queuePatch(row.beatmapId, { classification, status: "ready", error: null });
        } catch (err) {
          queuePatch(row.beatmapId, {
            classification: null,
            status: "error",
            error: err instanceof Error ? err.message : "Classification failed.",
          });
        }
      }
      flush();
      const done = cacheRef.current.get(family);
      if (done && !cancelled) {
        commitFamilyState(family, { ...done, classifiedAtRate: rate });
      }
    }

    return () => {
      cancelled = true;
      flush();
      setChartsProgress(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, rate]);

  // The only osu! API path on this page: explicitly fetch charts missing from
  // the local DB, one at a time, then classify them.
  const handleFetchMissing = useCallback(async () => {
    if (fetchMissingBusyRef.current) return;
    const fam = family;
    const currentRate = rate;
    const cache = cacheRef.current.get(fam);
    if (!cache) return;
    const hidden = hiddenByFamily[fam];
    const targets: Array<{ beatmapId: number; starRating: number }> = [];
    for (const set of cache.sets) {
      for (const row of set.rows) {
        if (row.status === "not-cached" && !hidden.has(row.beatmapId)) {
          targets.push({ beatmapId: row.beatmapId, starRating: row.starRating });
        }
      }
    }
    if (targets.length === 0) return;

    fetchMissingBusyRef.current = true;
    setFetchMissingProgress({ done: 0, total: targets.length });
    const preferFamily: PreferFamily = fam === "ln" ? "ln" : "rc";
    let done = 0;
    for (const target of targets) {
      try {
        patchRows(fam, new Map<number, Partial<BenchmarkRow>>([
          [target.beatmapId, { status: "classifying", error: null }],
        ]));
        const file = await getDanClassifierChartFile({ data: { beatmapId: target.beatmapId, allowOsuFetch: true } });
        if (file.content == null) throw new Error("Chart not available.");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const map = parseManiaBeatmap(file.content);
        const classification = await classifyChartWithCompanella(map, file.content, {
          rate: currentRate,
          starRating: target.starRating,
          title: map.title,
          version: map.version,
          preferFamily,
        });
        patchRows(fam, new Map<number, Partial<BenchmarkRow>>([
          [target.beatmapId, { content: file.content, classification, status: "ready", error: null }],
        ]));
      } catch (err) {
        patchRows(fam, new Map<number, Partial<BenchmarkRow>>([
          [target.beatmapId, { status: "error", error: err instanceof Error ? err.message : "osu! fetch failed." }],
        ]));
      }
      done += 1;
      setFetchMissingProgress({ done, total: targets.length });
    }
    fetchMissingBusyRef.current = false;
    setFetchMissingProgress(null);
  }, [family, rate, hiddenByFamily, patchRows]);

  const handleToggleHidden = useCallback(async (beatmapId: number, hidden: boolean) => {
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
  }, [family]);

  const handleExpectedChange = useCallback(async (beatmapId: number, value: string) => {
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
  }, [family]);

  // Export uses the loaded family caches; families not opened yet only get
  // metadata rows from the local DB (no chart fetches, no osu! API).
  async function buildExportDataset(): Promise<BenchmarkExportDataset> {
    const dataset: BenchmarkExportDataset = { normal: [], ln: [], ranked: [] };

    for (const fam of BENCHMARK_EXPORT_FAMILIES) {
      let cache = cacheRef.current.get(fam) ?? null;
      if (!cache) {
        cache = await loadBenchmarkFamilyMeta(fam);
        cacheRef.current.set(fam, cache);
      }
      for (const set of cache.sets) {
        for (const row of set.rows) {
          if (hiddenByFamily[fam].has(row.beatmapId)) continue;
          const expectedDan = expectedLabelsByFamily[fam].get(row.beatmapId)
            ?? getBenchmarkExpectedLabelOverride(fam, row.beatmapsetId, row.beatmapId, row.version);
          const estimate = row.classification?.estimate ?? null;
          const detectedDan = estimate?.displayName ?? estimate?.label ?? null;
          const detectedBase = estimate?.label ?? null;
          const expectedBase = expectedDan ? splitExpectedLabel(expectedDan).base : null;
          dataset[fam].push({
            family: fam,
            beatmapsetId: row.beatmapsetId,
            beatmapId: row.beatmapId,
            title: set.title,
            version: row.version,
            sr: row.starRating,
            srProxy: estimate?.estimatedSr ?? null,
            rawDan: estimate?.rawDan ?? null,
            confidence: estimate?.confidence ?? null,
            expectedDan: expectedDan ?? null,
            detectedDan,
            detectedFamily: estimate?.family ?? null,
            match: expectedBase && detectedBase ? expectedBase === detectedBase : null,
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

  const getEffectiveExpected = useCallback((row: BenchmarkRow): string => {
    return expectedLabels.get(row.beatmapId)
      ?? getBenchmarkExpectedLabelOverride(family, row.beatmapsetId, row.beatmapId, row.version)
      ?? "";
  }, [expectedLabels, family]);

  const sets = familyState?.sets ?? [];
  const allRows = sets.flatMap((set) => set.rows);
  const visibleRows = allRows.filter((row) => !hiddenSet.has(row.beatmapId));
  const totalDiffs = visibleRows.length;
  const hiddenCount = allRows.length - visibleRows.length;
  const readyCount = visibleRows.filter((row) => row.status === "ready").length;
  const notCachedCount = visibleRows.filter((row) => row.status === "not-cached").length;

  let exactMatchCount = 0;
  let baseMatchCount = 0;
  let labeledCount = 0;
  for (const row of visibleRows) {
    if (row.status !== "ready") continue;
    const estimate = row.classification?.estimate;
    if (!estimate) continue;
    const expected = getEffectiveExpected(row);
    if (!expected) continue;
    labeledCount += 1;
    if (expected === `${estimate.label}${estimate.variant ?? ""}`) exactMatchCount += 1;
    else if (splitExpectedLabel(expected).base === estimate.label) baseMatchCount += 1;
  }
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
          <SubTab active={family === "ranked"} onClick={() => onFamilyChange("ranked")}>Ranked</SubTab>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-osu-f1 sm:gap-3">
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
            {chartsProgress ? (
              <span>loading charts {chartsProgress.loaded}/{chartsProgress.total}</span>
            ) : readyCount < totalDiffs - notCachedCount ? (
              <span>classifying <span className="font-bold text-osu-c1">{readyCount}</span>/{totalDiffs}</span>
            ) : (
              <span><span className="font-bold text-osu-c1">{readyCount}</span>/{totalDiffs}</span>
            )}
          </div>
          {notCachedCount > 0 || fetchMissingProgress ? (
            <button
              type="button"
              onClick={() => void handleFetchMissing()}
              disabled={fetchMissingProgress != null}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-osu-pink/40 bg-osu-pink/15 px-2 py-0.5 font-bold uppercase tracking-wide text-white transition-colors cursor-pointer hover:bg-osu-pink/25 disabled:cursor-not-allowed disabled:opacity-70"
              title="Fetch uncached charts from the osu! API, one at a time"
            >
              <Download className="h-3 w-3" />
              {fetchMissingProgress
                ? `fetching ${fetchMissingProgress.done}/${fetchMissingProgress.total}`
                : `fetch missing from osu! (${notCachedCount})`}
            </button>
          ) : null}
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
              title="Download dataset (all families) as a styled Excel workbook"
            >
              <FileSpreadsheet className="h-3 w-3" />
              {getExportButtonText("excel")}
            </button>
            <button
              type="button"
              onClick={() => void handleExportDataset("markdown")}
              disabled={exportBusy}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 font-bold uppercase tracking-wide transition-colors cursor-pointer disabled:cursor-not-allowed ${getExportButtonClass("markdown")}`}
              title="Copy dataset (all families) as Markdown tables"
            >
              <ClipboardList className="h-3 w-3" />
              {getExportButtonText("markdown")}
            </button>
          </div>
        </div>
      </div>

      {familyState && familyState.missingIds.length > 0 ? (
        <div className="mt-3 px-2 text-[11px] text-osu-f1">
          Not in local DB: {familyState.missingIds.join(", ")}
        </div>
      ) : null}

      {metaError ? (
        <div className="mt-4 rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3 text-sm text-osu-red">
          {metaError}
        </div>
      ) : metaLoading || !familyState ? (
        <div className="mt-8 flex flex-col items-center gap-3 py-10">
          <div className="w-7 h-7 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
          <div className="text-sm text-osu-f1">Loading benchmark sets from the local DB...</div>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {sets.map((set) => (
            <BenchmarkSetBlock
              key={set.beatmapsetId}
              set={set}
              family={family}
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
      )}
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

interface BenchmarkSetBlockProps {
  set: BenchmarkSetState;
  family: DanBenchmarkFamily;
  labelOptions: string[];
  expectedLabels: Map<number, string>;
  hiddenSet: Set<number>;
  showHidden: boolean;
  onToggleHidden: (beatmapId: number, hidden: boolean) => void;
  onExpectedChange: (beatmapId: number, value: string) => void;
  onAnalyze: (target: AnalyzeTarget) => void;
  onCopyId: (id: number) => void;
  copiedBeatmapId: number | null;
  selectedBeatmapId: number | null;
}

const BenchmarkSetBlock = memo(function BenchmarkSetBlock({
  set,
  family,
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
  const visibleRows = set.rows.filter((row) => {
    if (hiddenSet.has(row.beatmapId)) return showHidden;
    return true;
  });

  return (
    <div className="min-w-0 rounded-md border border-osu-b3/30 bg-osu-b5/40 overflow-hidden [content-visibility:auto] [contain-intrinsic-size:360px]">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[11px] border-b border-osu-b3/20 bg-osu-b5/60">
        <span className="min-w-0 truncate text-white font-bold">{set.title}</span>
        {set.artist ? <span className="shrink-0 text-osu-f1 truncate">// {set.artist}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCopyId(set.beatmapsetId)}
            className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-osu-l2 hover:text-white transition-colors"
            title={`Copy beatmapset ID ${set.beatmapsetId}`}
            aria-label={`Copy beatmapset ID ${set.beatmapsetId}`}
          >
            {copiedBeatmapId === set.beatmapsetId ? (
              <Check className="h-3 w-3" strokeWidth={3} />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
          <a
            href={`https://osu.ppy.sh/beatmapsets/${set.beatmapsetId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-osu-l2 hover:text-white transition-colors"
          >
            osu!
          </a>
        </div>
      </div>

      {set.rows.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] text-osu-f1">No 4K mania diffs in the local DB.</div>
      ) : visibleRows.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] text-osu-f1 italic">All diffs hidden.</div>
      ) : (
        <div className={`grid gap-1.5 p-1.5 ${visibleRows.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {visibleRows.map((row) => (
            <BenchmarkDiffRow
              key={row.beatmapId}
              row={row}
              setTitle={set.title}
              setArtist={set.artist}
              family={family}
              labelOptions={labelOptions}
              expected={
                expectedLabels.get(row.beatmapId)
                ?? getBenchmarkExpectedLabelOverride(family, row.beatmapsetId, row.beatmapId, row.version)
                ?? ""
              }
              isHidden={hiddenSet.has(row.beatmapId)}
              onToggleHidden={onToggleHidden}
              onExpectedChange={onExpectedChange}
              onAnalyze={onAnalyze}
              isSelected={row.beatmapId === selectedBeatmapId}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface BenchmarkDiffRowProps {
  row: BenchmarkRow;
  setTitle: string;
  setArtist: string | null;
  family: DanBenchmarkFamily;
  labelOptions: string[];
  expected: string;
  isHidden: boolean;
  onToggleHidden: (beatmapId: number, hidden: boolean) => void;
  onExpectedChange: (beatmapId: number, value: string) => void;
  onAnalyze: (target: AnalyzeTarget) => void;
  isSelected: boolean;
}

const BenchmarkDiffRow = memo(function BenchmarkDiffRow({
  row,
  setTitle,
  setArtist,
  family,
  labelOptions,
  expected,
  isHidden,
  onToggleHidden,
  onExpectedChange,
  onAnalyze,
  isSelected,
}: BenchmarkDiffRowProps) {
  const estimate = row.classification?.estimate ?? null;
  const estimateLabel = estimate?.label ?? null;
  const estimateDisplay = estimate?.displayName ?? estimateLabel;
  const estimateFamily = estimate?.family ?? null;
  const estimateImage = estimateLabel ? getDanImageSrc(estimateLabel, estimateFamily ?? undefined) : null;

  const expectedSplit = expected ? splitExpectedLabel(expected) : { base: "", variant: "" as DanVariant };

  let matchState: "exact" | "base" | "wrong" | "unset" = "unset";
  if (expected && estimateLabel && row.status === "ready") {
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
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleHidden(row.beatmapId, !isHidden);
        }}
        className={`absolute right-1 top-1 z-10 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-osu-f1 transition-all hover:bg-osu-b4/70 hover:text-white ${
          isHidden ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        title={isHidden ? "Restore diff" : "Hide diff from benchmark"}
        aria-label={isHidden ? "Restore diff" : "Hide diff from benchmark"}
      >
        {isHidden ? <RotateCcw className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </button>

      <button
        type="button"
        onClick={() => onAnalyze({
          beatmapId: row.beatmapId,
          title: setTitle,
          artist: setArtist,
          version: row.version,
          starRating: row.starRating > 0 ? row.starRating : null,
          preferFamily: family === "ln" ? "ln" : "rc",
        })}
        className="relative flex min-w-0 cursor-pointer items-center gap-3 px-2.5 pt-2.5 pb-2 text-left"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center">
          {row.status === "pending" || row.status === "classifying" ? (
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
            {row.status === "not-cached" ? (
              <span className="text-sm font-bold text-osu-f1 italic">not cached</span>
            ) : (
              <span className="text-sm font-black text-white truncate">
                {estimateDisplay ?? "--"}
              </span>
            )}
            {estimateFamily && row.status === "ready" ? (
              <span className="text-[9px] uppercase tracking-wide text-osu-yellow font-bold">{estimateFamily}</span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-start gap-1.5 text-[10px] text-osu-f1">
            <span className="shrink-0 tabular-nums text-osu-l2 leading-tight">&#9733;{row.starRating.toFixed(2)}</span>
            <span className="min-w-0 leading-tight line-clamp-2 break-words">{cleanVersionLabel(row.version)}</span>
          </div>
        </div>
      </button>

      <div className="relative flex items-center gap-1 px-2.5 pb-2">
        <select
          value={expectedSplit.base}
          onChange={(event) => {
            const nextBase = event.target.value;
            if (!nextBase) {
              onExpectedChange(row.beatmapId, "");
              return;
            }
            onExpectedChange(row.beatmapId, joinExpectedLabel(nextBase, expectedSplit.variant));
          }}
          onClick={(event) => event.stopPropagation()}
          className="flex-1 min-w-0 rounded border border-osu-b3/50 bg-osu-b5/80 px-1.5 py-0.5 text-[11px] text-osu-c1 focus:border-osu-h1/40 focus:outline-none cursor-pointer"
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
            onExpectedChange(row.beatmapId, joinExpectedLabel(expectedSplit.base, nextVariant));
          }}
          onClick={(event) => event.stopPropagation()}
          disabled={!expectedSplit.base}
          className="w-12 shrink-0 rounded border border-osu-b3/50 bg-osu-b5/80 px-1 py-0.5 text-[11px] text-osu-c1 focus:border-osu-h1/40 focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-center"
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
                  : row.status === "not-cached"
                    ? "Not cached; excluded from accuracy"
                    : "No expected dan set"
          }
        >
          {matchState === "exact" ? <Check className="h-3 w-3" strokeWidth={3} /> : matchState === "base" ? "~" : matchState === "wrong" ? "!" : ""}
        </span>
      </div>
    </div>
  );
});
