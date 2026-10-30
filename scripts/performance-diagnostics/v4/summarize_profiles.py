#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run directly (no venv, no pip install needed):
#      uv run summarize_profiles.py INPUT.cpuprofile OUTPUT.json
# 3. Or make executable and run:
#      chmod +x summarize_profiles.py && ./summarize_profiles.py INPUT.cpuprofile OUTPUT.json
# ──────────────────

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import TypedDict

MAX_PROFILE_BYTES = 64 * 1024 * 1024


class CallFrame(TypedDict):
    functionName: str
    url: str


class CpuProfileNode(TypedDict):
    id: int
    callFrame: CallFrame


class CpuProfile(TypedDict):
    nodes: list[CpuProfileNode]
    samples: list[int]


class RedactedSummary(TypedDict):
    status: str
    sampleCount: int
    categoryCounts: dict[str, int]


class InvalidProfileError(ValueError):
    """A bounded profile format or content failure."""

    def __init__(self, reason_code: str) -> None:
        self.reason_code = reason_code
        super().__init__(reason_code)


def parse_profile(raw_profile: bytes) -> CpuProfile:
    """Parse untrusted Node CPU profile JSON into the minimal typed shape."""
    try:
        raw_value = json.loads(raw_profile)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidProfileError('invalid_json') from error
    if not isinstance(raw_value, dict):
        raise InvalidProfileError('invalid_root')
    raw_nodes = raw_value.get('nodes')
    raw_samples = raw_value.get('samples')
    if not isinstance(raw_nodes, list) or not isinstance(raw_samples, list):
        raise InvalidProfileError('missing_profile_arrays')

    nodes: list[CpuProfileNode] = []
    node_ids: set[int] = set()
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            raise InvalidProfileError('invalid_node')
        node_id = raw_node.get('id')
        raw_frame = raw_node.get('callFrame')
        if not isinstance(node_id, int) or isinstance(node_id, bool) or node_id <= 0 or node_id in node_ids:
            raise InvalidProfileError('invalid_node_id')
        if not isinstance(raw_frame, dict):
            raise InvalidProfileError('invalid_call_frame')
        function_name = raw_frame.get('functionName', '')
        url = raw_frame.get('url', '')
        if not isinstance(function_name, str) or not isinstance(url, str):
            raise InvalidProfileError('invalid_call_frame')
        node_ids.add(node_id)
        nodes.append({'id': node_id, 'callFrame': {'functionName': function_name, 'url': url}})

    samples: list[int] = []
    for sample in raw_samples:
        if not isinstance(sample, int) or isinstance(sample, bool) or sample not in node_ids:
            raise InvalidProfileError('sample_references_unknown_node')
        samples.append(sample)
    return {'nodes': nodes, 'samples': samples}


def categorize(frame: CallFrame) -> str:
    """Map a source-bearing frame to a fixed, source-free category."""
    name = frame['functionName']
    url = frame['url'].replace('\\', '/')
    if name in ('(idle)', '(program)', '(garbage collector)'):
        return name
    if '/src/indexer/' in url:
        return 'indexer'
    if '/src/storage/' in url:
        return 'storage'
    if '/src/structured/' in url:
        return 'structured'
    if '/src/observability/' in url:
        return 'observer'
    if '/tests/benchmarks/performance/' in url:
        return 'benchmark_harness'
    if '/src/server/' in url:
        return 'server'
    if '/node_modules/' in url:
        return 'dependency'
    if url.startswith('node:') or 'node:internal/' in url:
        return 'node_internal'
    if url == '':
        return 'native_or_unattributed'
    return 'other'


def summarize_profile(profile: CpuProfile) -> RedactedSummary:
    """Count self samples by fixed category without returning frame labels."""
    by_id = {node['id']: node['callFrame'] for node in profile['nodes']}
    category_counts: dict[str, int] = {}
    for sample in profile['samples']:
        frame = by_id.get(sample)
        if frame is None:
            raise InvalidProfileError('sample_references_unknown_node')
        category = categorize(frame)
        category_counts[category] = category_counts.get(category, 0) + 1
    return {
        'status': 'parsed',
        'sampleCount': len(profile['samples']),
        'categoryCounts': category_counts,
    }


def read_profile(path: Path) -> CpuProfile:
    """Read a profile under the per-segment byte ceiling and parse it."""
    with path.open('rb') as profile_file:
        raw_profile = profile_file.read(MAX_PROFILE_BYTES + 1)
    if len(raw_profile) > MAX_PROFILE_BYTES:
        raise InvalidProfileError('profile_too_large')
    return parse_profile(raw_profile)


def write_summary_exclusive(path: Path, summary: RedactedSummary) -> None:
    """Create a source-free summary without overwriting prior evidence."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as summary_file:
        json.dump(summary, summary_file, ensure_ascii=False, separators=(',', ':'))
        summary_file.write('\n')


def main(arguments: list[str]) -> int:
    """Summarize one bounded CPU profile to a new output file."""
    if len(arguments) != 3:
        sys.stderr.write('usage: summarize_profiles.py INPUT.cpuprofile OUTPUT.json\n')
        return 2
    profile_path = Path(arguments[1])
    output_path = Path(arguments[2])
    try:
        summary = summarize_profile(read_profile(profile_path))
        write_summary_exclusive(output_path, summary)
    except (InvalidProfileError, OSError) as error:
        reason_code = error.reason_code if isinstance(error, InvalidProfileError) else 'profile_io_error'
        sys.stderr.write(f'profile_summary_failed:{reason_code}\n')
        return 1
    sys.stdout.write(f"profile_summary_written:{summary['sampleCount']}\n")
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
