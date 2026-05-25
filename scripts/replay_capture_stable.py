#!/usr/bin/env python3
"""Capture osu!stable replay truth from a local tosu/gosumemory JSON API.

This script is intentionally standalone: it only uses Python's standard
library, so it can be copied to Windows and run outside the Mania Hub project.

Examples:
  py replay_capture_stable.py 6698595595
  py replay_capture_stable.py --interval 8 --duration 150000 2212454313
  python replay_capture_stable.py --base-url http://127.0.0.1:24050 --all --full-raw
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:24050"
DEFAULT_ENDPOINTS = ("/json/v2", "/json")
DEFAULT_OUT_DIR = "capture-replays"
COUNT_KEYS = ("countGeki", "count300", "countKatu", "count100", "count50", "countMiss")

stop_requested = False


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def get_path(root: Any, path: str) -> Any:
    current = root
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().replace("%", "").replace(",", "").replace(" ", "")
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def as_string(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return None


def as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalised = value.strip().lower()
        if normalised in {"1", "true", "yes", "pressed"}:
            return True
        if normalised in {"0", "false", "no", "released"}:
            return False
    return None


def number_from_paths(root: Any, paths: tuple[str, ...] | list[str]) -> float | None:
    for path in paths:
        value = as_number(get_path(root, path))
        if value is not None:
            return value
    return None


def string_from_paths(root: Any, paths: tuple[str, ...] | list[str]) -> str | None:
    for path in paths:
        value = as_string(get_path(root, path))
        if value is not None:
            return value
    return None


def record_from_paths(root: Any, paths: tuple[str, ...] | list[str]) -> dict[str, Any] | None:
    for path in paths:
        value = get_path(root, path)
        if isinstance(value, dict):
            return value
    return None


def count_from_hit_object(hits: dict[str, Any], keys: tuple[str, ...] | list[str]) -> int:
    for key in keys:
        value = as_number(hits.get(key))
        if value is not None:
            return max(0, int(value))
    return 0


def counts_total(counts: dict[str, int]) -> int:
    return sum(int(counts.get(key, 0)) for key in COUNT_KEYS)


def counts_from_hit_object(hits: dict[str, Any]) -> dict[str, int]:
    return {
        "countGeki": count_from_hit_object(hits, ("geki", "max", "perfect", "countGeki")),
        "count300": count_from_hit_object(hits, ("300", "great", "count300")),
        "countKatu": count_from_hit_object(hits, ("katu", "200", "good", "countKatu")),
        "count100": count_from_hit_object(hits, ("100", "ok", "count100")),
        "count50": count_from_hit_object(hits, ("50", "meh", "count50")),
        "countMiss": count_from_hit_object(hits, ("0", "miss", "misses", "countMiss")),
    }


def hit_error_array(root: Any) -> list[float]:
    value = get_path(root, "play.hitErrorArray")
    if not isinstance(value, list):
        value = get_path(root, "gameplay.hitErrorArray")
    if not isinstance(value, list):
        return []

    result = []
    for item in value:
        number = as_number(item)
        if number is not None:
            result.append(number)
    return result


def pick_hit_counts(root: Any) -> dict[str, int]:
    if string_from_paths(root, ("state.name", "state")) == "play":
        play_hits = get_path(root, "play.hits")
        if isinstance(play_hits, dict):
            return counts_from_hit_object(play_hits)

    fallback = None
    for path in ("play.hits", "gameplay.hits", "resultsScreen.hits", "score.hits", "hits"):
        record = get_path(root, path)
        if not isinstance(record, dict):
            continue
        counts = counts_from_hit_object(record)
        if fallback is None:
            fallback = counts
        if counts_total(counts) > 0:
            return counts
    return fallback or {
        "countGeki": 0,
        "count300": 0,
        "countKatu": 0,
        "count100": 0,
        "count50": 0,
        "countMiss": 0,
    }


def pick_keys(root: Any) -> dict[str, dict[str, Any]] | None:
    record = record_from_paths(root, ("keys", "play.keys", "gameplay.keyOverlay", "keyOverlay"))
    if not record:
        return None

    keys = {}
    for key, value in record.items():
        if isinstance(value, dict):
            keys[str(key)] = {
                "count": number_from_paths(value, ("count", "pressCount")),
                "pressed": as_bool(value.get("isPressed", value.get("pressed", value.get("down")))),
            }
        else:
            keys[str(key)] = {
                "count": None,
                "pressed": as_bool(value),
            }

    return keys or None


def normalize_result_screen(raw: Any) -> dict[str, Any] | None:
    result = get_path(raw, "resultsScreen")
    if not isinstance(result, dict):
        return None

    hits = result.get("hits")
    counts = counts_from_hit_object(hits) if isinstance(hits, dict) else None
    return {
        "accuracy": normalize_accuracy(number_from_paths(result, ("accuracy",))),
        "combo": number_from_paths(result, ("combo.current", "combo")),
        "counts": counts,
        "createdAt": string_from_paths(result, ("createdAt", "date")),
        "maxCombo": number_from_paths(result, ("combo.max", "maxCombo")),
        "playerName": string_from_paths(result, ("playerName", "name", "user.name")),
        "score": number_from_paths(result, ("score",)),
        "scoreId": number_from_paths(result, ("scoreId", "id")),
        "totalHits": counts_total(counts) if counts is not None else None,
    }


def normalize_leaderboard(raw: Any) -> list[dict[str, Any]]:
    leaderboard = get_path(raw, "leaderboard")
    if not isinstance(leaderboard, list):
        leaderboard = get_path(raw, "play.leaderboard")
    if not isinstance(leaderboard, list):
        return []

    rows = []
    for entry in leaderboard:
        if not isinstance(entry, dict):
            continue
        hits = entry.get("hits")
        counts = counts_from_hit_object(hits) if isinstance(hits, dict) else None
        rows.append({
            "accuracy": normalize_accuracy(as_number(entry.get("accuracy"))),
            "combo": number_from_paths(entry, ("combo.current", "combo")),
            "counts": counts,
            "id": as_number(entry.get("id")),
            "maxCombo": number_from_paths(entry, ("combo.max", "maxCombo")),
            "name": as_string(entry.get("name")),
            "position": as_number(entry.get("position")),
            "score": as_number(entry.get("score")),
            "totalHits": counts_total(counts) if counts is not None else None,
        })
    return rows


def normalize_accuracy(value: float | None) -> float | None:
    if value is None:
        return None
    return value * 100 if 0 < value <= 1 else value


def normalize_snapshot(raw: Any) -> dict[str, Any]:
    counts = pick_hit_counts(raw)
    errors = hit_error_array(raw)
    return {
        "accuracy": normalize_accuracy(number_from_paths(raw, (
            "play.accuracy",
            "gameplay.accuracy",
            "resultsScreen.accuracy",
            "accuracy",
        ))),
        "beatmap": {
            "artist": string_from_paths(raw, ("beatmap.artist", "beatmap.metadata.artist", "menu.bm.metadata.artist")),
            "beatmapId": number_from_paths(raw, ("beatmap.id", "beatmap.beatmapId", "menu.bm.id")),
            "beatmapsetId": number_from_paths(raw, ("beatmap.set", "beatmap.beatmapsetId", "menu.bm.set")),
            "checksum": string_from_paths(raw, ("beatmap.checksum", "menu.bm.checksum")),
            "title": string_from_paths(raw, ("beatmap.title", "beatmap.metadata.title", "menu.bm.metadata.title")),
            "version": string_from_paths(raw, ("beatmap.version", "beatmap.metadata.difficulty", "menu.bm.metadata.difficulty")),
        },
        "combo": number_from_paths(raw, (
            "play.combo.current",
            "gameplay.combo.current",
            "resultsScreen.combo.current",
            "combo.current",
        )),
        "counts": counts,
        "currentTime": number_from_paths(raw, (
            "beatmap.time.live",
            "beatmap.time.current",
            "menu.bm.time.current",
            "gameplay.time.current",
            "time.current",
        )),
        "hitErrorTail": errors[-16:],
        "hitErrorTotal": len(errors),
        "keys": pick_keys(raw),
        "leaderboard": normalize_leaderboard(raw),
        "maxCombo": number_from_paths(raw, (
            "play.combo.max",
            "gameplay.combo.max",
            "resultsScreen.combo.max",
            "combo.max",
        )),
        "playerName": string_from_paths(raw, (
            "play.playerName",
            "gameplay.name",
            "resultsScreen.name",
            "player.name",
        )),
        "score": number_from_paths(raw, (
            "play.score",
            "gameplay.score",
            "resultsScreen.score",
            "score",
        )),
        "resultScreen": normalize_result_screen(raw),
        "sliderBreaks": number_from_paths(raw, (
            "play.hits.sliderBreaks",
            "gameplay.hits.sliderBreaks",
            "sliderBreaks",
        )),
        "stateName": string_from_paths(raw, (
            "state.name",
            "state",
            "menu.state.name",
            "menu.state",
        )),
        "totalHits": counts_total(counts),
    }


def compact_raw_snapshot(raw: Any, include_hit_errors: bool = True) -> dict[str, Any]:
    play = record_from_paths(raw, ("play", "gameplay")) or {}
    play_hits = play.get("hits") if isinstance(play.get("hits"), dict) else {}
    play_combo = play.get("combo") if isinstance(play.get("combo"), dict) else {}
    live_time = number_from_paths(raw, (
        "beatmap.time.live",
        "beatmap.time.current",
        "menu.bm.time.current",
        "gameplay.time.current",
        "time.current",
    ))

    return {
        "beatmap": {
            "time": {"live": live_time} if live_time is not None else {},
        },
        "leaderboard": raw.get("leaderboard") if isinstance(raw, dict) and isinstance(raw.get("leaderboard"), list) else get_path(raw, "play.leaderboard"),
        "play": {
            "accuracy": normalize_accuracy(number_from_paths(raw, ("play.accuracy", "gameplay.accuracy"))),
            "combo": {
                "current": as_number(play_combo.get("current")) if isinstance(play_combo, dict) else number_from_paths(raw, ("play.combo.current", "gameplay.combo.current")),
                "max": as_number(play_combo.get("max")) if isinstance(play_combo, dict) else number_from_paths(raw, ("play.combo.max", "gameplay.combo.max")),
            },
            "hitErrorArray": hit_error_array(raw) if include_hit_errors else [],
            "hits": play_hits,
            "playerName": string_from_paths(raw, ("play.playerName", "gameplay.name")),
            "score": number_from_paths(raw, ("play.score", "gameplay.score")),
        },
        "resultsScreen": raw.get("resultsScreen") if isinstance(raw, dict) else None,
        "state": {
            "name": string_from_paths(raw, ("state.name", "state", "menu.state.name", "menu.state")),
            "number": number_from_paths(raw, ("state.number", "menu.state.number")),
        },
    }


def scoreboard_signature(snapshot: dict[str, Any]) -> str:
    accuracy = snapshot.get("accuracy")
    return json.dumps({
        "accuracy": round(accuracy, 6) if isinstance(accuracy, (int, float)) else None,
        "beatmap": snapshot.get("beatmap"),
        "combo": snapshot.get("combo"),
        "counts": snapshot.get("counts"),
        "maxCombo": snapshot.get("maxCombo"),
        "playerName": snapshot.get("playerName"),
        "score": snapshot.get("score"),
        "stateName": snapshot.get("stateName"),
    }, sort_keys=True, separators=(",", ":"))


def source_signature(snapshot: dict[str, Any]) -> str:
    leaderboard = []
    for entry in snapshot.get("leaderboard") or []:
        leaderboard.append({
            "counts": entry.get("counts"),
            "id": entry.get("id"),
            "maxCombo": entry.get("maxCombo"),
            "position": entry.get("position"),
            "score": entry.get("score"),
        })

    result = snapshot.get("resultScreen")
    return json.dumps({
        "hitErrorTotal": snapshot.get("hitErrorTotal"),
        "leaderboard": leaderboard[:8],
        "resultScreen": result,
        "sliderBreaks": snapshot.get("sliderBreaks"),
    }, sort_keys=True, separators=(",", ":"))


def count_delta(previous: dict[str, int] | None, current: dict[str, int]) -> dict[str, int] | None:
    if previous is None:
        return current if counts_total(current) > 0 else None

    delta = {}
    for key in COUNT_KEYS:
        value = int(current.get(key, 0)) - int(previous.get(key, 0))
        if value:
            delta[key] = value
    return delta or None


def make_url(base_url: str, endpoint: str) -> str:
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        return endpoint
    return base_url.rstrip("/") + "/" + endpoint.lstrip("/")


def fetch_json(url: str, timeout: float) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def resolve_endpoint(base_url: str, endpoint: str | None, timeout: float) -> tuple[str, Any]:
    errors = []
    endpoints = (endpoint,) if endpoint else DEFAULT_ENDPOINTS

    for candidate in endpoints:
        url = make_url(base_url, candidate)
        try:
            return url, fetch_json(url, timeout)
        except Exception as exc:
            errors.append(f"{url}: {exc}")

    message = "\n".join([
        "Could not read a JSON stream from tosu/gosumemory.",
        "Start tosu or gosumemory, open osu!stable, then try again.",
        *("  " + error for error in errors),
    ])
    raise RuntimeError(message)


def safe_file_label(label: str | None) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", label or "stable-replay").strip("_")[:90]
    return cleaned or "stable-replay"


def timestamp_for_file() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")[:-4] + "Z"


def resolve_output_path(args: argparse.Namespace) -> Path:
    if args.out:
        return Path(args.out).expanduser().resolve()
    return (Path(args.out_dir) / f"{safe_file_label(args.label)}-{timestamp_for_file()}.ndjson").resolve()


def summary_path_for(out_path: Path) -> Path:
    if out_path.suffix == ".ndjson":
        return out_path.with_suffix(".summary.json")
    return out_path.with_name(out_path.name + ".summary.json")


def format_replay_time(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "?:??.???"
    total_ms = max(0, int(value))
    minutes = total_ms // 60000
    seconds = (total_ms % 60000) // 1000
    milliseconds = total_ms % 1000
    return f"{minutes}:{seconds:02d}.{milliseconds:03d}"


def format_signed(value: int) -> str:
    return f"+{value}" if value > 0 else str(value)


def format_counts(counts: dict[str, int]) -> str:
    return " / ".join((
        f"MAX {counts.get('countGeki', 0)}",
        f"300 {counts.get('count300', 0)}",
        f"200 {counts.get('countKatu', 0)}",
        f"100 {counts.get('count100', 0)}",
        f"50 {counts.get('count50', 0)}",
        f"Miss {counts.get('countMiss', 0)}",
    ))


def format_delta(delta: dict[str, int] | None) -> str:
    if not delta:
        return ""
    labels = (
        ("MAX", "countGeki"),
        ("300", "count300"),
        ("200", "countKatu"),
        ("100", "count100"),
        ("50", "count50"),
        ("Miss", "countMiss"),
    )
    return " ".join(f"{label}{format_signed(delta[key])}" for label, key in labels if key in delta)


def print_live_change(snapshot: dict[str, Any], delta: dict[str, int] | None) -> None:
    accuracy = snapshot.get("accuracy")
    accuracy_text = f"{accuracy:.2f}%" if isinstance(accuracy, (int, float)) else "acc ?"
    combo = snapshot.get("combo")
    combo_text = f"{int(combo)}x" if isinstance(combo, (int, float)) else "combo ?"
    score = snapshot.get("score")
    score_text = str(int(score)) if isinstance(score, (int, float)) else "score ?"
    delta_text = f" | {format_delta(delta)}" if delta else ""
    print(
        f"[{format_replay_time(snapshot.get('currentTime'))}] "
        f"{accuracy_text} {combo_text} {score_text} | "
        f"{format_counts(snapshot.get('counts', {}))}{delta_text}",
        flush=True,
    )


def write_json_line(handle: Any, value: Any) -> None:
    handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    handle.flush()


def handle_stop(_signum: int, _frame: Any) -> None:
    global stop_requested
    stop_requested = True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Capture osu!stable replay scoreboard/count truth from tosu/gosumemory.",
    )
    parser.add_argument("label", nargs="?", help="Score id or label used for the output filename.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"tosu/gosumemory base URL. Default: {DEFAULT_BASE_URL}")
    parser.add_argument("--endpoint", help="JSON endpoint to poll. Default: auto-detect /json/v2 then /json")
    parser.add_argument("--interval", type=float, default=16, help="Poll interval in milliseconds. Default: 16")
    parser.add_argument("--duration", type=float, help="Stop after this many milliseconds. Default: until Ctrl+C")
    parser.add_argument("--out", help="Write NDJSON capture to this file.")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help=f"Output directory when --out is omitted. Default: {DEFAULT_OUT_DIR}")
    parser.add_argument("--all", action="store_true", help="Write every poll sample, not only scoreboard/count changes.")
    parser.add_argument("--full-raw", action="store_true", help="Write full API snapshots. Large; only use for deep source debugging.")
    parser.add_argument("--full-hit-errors", action="store_true", help="With compact raw output, repeat the full hit-error array on every written row.")
    parser.add_argument("--no-raw", action="store_true", help="Omit compact raw API snapshots from NDJSON rows.")
    parser.add_argument("--quiet", action="store_true", help="Do not print live scoreboard changes.")
    parser.add_argument("--timeout", type=float, default=750, help="HTTP timeout in milliseconds. Default: 750")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.interval <= 0:
        parser.error("--interval must be positive")
    if args.duration is not None and args.duration <= 0:
        parser.error("--duration must be positive")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.full_raw and args.no_raw:
        parser.error("--full-raw and --no-raw cannot be used together")

    signal.signal(signal.SIGINT, handle_stop)
    signal.signal(signal.SIGTERM, handle_stop)

    started_at = utc_now()
    start = time.perf_counter()
    out_path = resolve_output_path(args)
    summary_path = summary_path_for(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        endpoint_url, initial_raw = resolve_endpoint(args.base_url, args.endpoint, args.timeout / 1000)
    except Exception as exc:
        print(exc, file=sys.stderr)
        return 1

    stats = {
        "countChangeCount": 0,
        "errorCount": 0,
        "lastErrorMessage": None,
        "sampleCount": 0,
        "sourceChangeCount": 0,
        "scoreboardChangeCount": 0,
        "writtenSamples": 0,
    }
    first_snapshot = None
    last_snapshot = None
    previous_counts = None
    previous_signature = None
    previous_source_signature = None
    queued_initial_raw = initial_raw

    if not args.quiet:
        print(f"Capturing {endpoint_url}")
        print(f"Writing {out_path}")
        print("Press Ctrl+C to stop." if args.duration is None else f"Stopping after {int(args.duration)}ms.")

    with out_path.open("w", encoding="utf-8") as handle:
        write_json_line(handle, {
            "type": "start",
            "baseUrl": args.base_url,
            "endpoint": endpoint_url,
            "includeRaw": "none" if args.no_raw else ("full" if args.full_raw else "compact"),
            "includeRawHitErrors": None if args.no_raw or args.full_raw else ("all" if args.full_hit_errors else "count-or-scoreboard-changes"),
            "intervalMs": args.interval,
            "label": args.label,
            "schemaVersion": 3,
            "startedAt": started_at,
            "tool": "replay_capture_stable.py",
        })

        try:
            while not stop_requested:
                elapsed_ms = (time.perf_counter() - start) * 1000
                if args.duration is not None and elapsed_ms >= args.duration:
                    break

                try:
                    raw = queued_initial_raw if queued_initial_raw is not None else fetch_json(endpoint_url, args.timeout / 1000)
                    queued_initial_raw = None
                    normalized = normalize_snapshot(raw)
                    signature = scoreboard_signature(normalized)
                    source_sig = source_signature(normalized)
                    delta = count_delta(previous_counts, normalized["counts"])
                    scoreboard_changed = previous_signature is None or signature != previous_signature
                    source_changed = previous_source_signature is None or source_sig != previous_source_signature
                    should_write = args.all or scoreboard_changed or source_changed or delta is not None

                    stats["sampleCount"] += 1
                    if scoreboard_changed:
                        stats["scoreboardChangeCount"] += 1
                    if source_changed:
                        stats["sourceChangeCount"] += 1
                    if delta:
                        stats["countChangeCount"] += 1
                    if first_snapshot is None:
                        first_snapshot = normalized
                    last_snapshot = normalized

                    if should_write:
                        row = {
                            "type": "sample",
                            "capturedAt": utc_now(),
                            "changed": scoreboard_changed,
                            "countDelta": delta,
                            "elapsedMs": round(elapsed_ms, 3),
                            "normalized": normalized,
                            "sequence": stats["sampleCount"],
                            "sourceChanged": source_changed,
                        }
                        if not args.no_raw:
                            include_hit_errors = args.full_hit_errors or delta is not None or scoreboard_changed
                            row["raw"] = raw if args.full_raw else compact_raw_snapshot(raw, include_hit_errors)
                        write_json_line(handle, row)
                        stats["writtenSamples"] += 1

                    if not args.quiet and scoreboard_changed:
                        print_live_change(normalized, delta)

                    previous_counts = normalized["counts"]
                    previous_signature = signature
                    previous_source_signature = source_sig
                except Exception as exc:
                    message = str(exc)
                    stats["errorCount"] += 1
                    stats["lastErrorMessage"] = message
                    write_json_line(handle, {
                        "type": "error",
                        "capturedAt": utc_now(),
                        "elapsedMs": round((time.perf_counter() - start) * 1000, 3),
                        "message": message,
                        "sequence": stats["sampleCount"] + 1,
                    })
                    if not args.quiet:
                        print(f"[capture warning] {message}", file=sys.stderr)

                time.sleep(args.interval / 1000)
        finally:
            summary = {
                "type": "summary",
                "durationMs": round((time.perf_counter() - start) * 1000, 3),
                "endedAt": utc_now(),
                "endpoint": endpoint_url,
                "firstSnapshot": first_snapshot,
                "lastSnapshot": last_snapshot,
                "outPath": str(out_path),
                "startedAt": started_at,
                "stats": stats,
                "tool": "replay_capture_stable.py",
            }
            write_json_line(handle, summary)
            summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if not args.quiet:
        print(f"Capture written: {out_path}")
        print(f"Summary written: {summary_path}")
        print(
            f"Samples polled {stats['sampleCount']}, samples written {stats['writtenSamples']}, "
            f"count changes {stats['countChangeCount']}, source changes {stats['sourceChangeCount']}, "
            f"errors {stats['errorCount']}."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
