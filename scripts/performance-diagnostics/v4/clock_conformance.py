#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run a preflight-only clock calibration:
#      uv run clock_conformance.py /absolute/path/to/node start
#      uv run clock_conformance.py /absolute/path/to/node end
# 3. Or make executable and run:
#      chmod +x clock_conformance.py && ./clock_conformance.py /absolute/path/to/node start
# ──────────────────

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time
from typing import TypedDict

PING_COUNT = 30
LINE_TIMEOUT_SECONDS = 5.0
NODE_PROBE = """
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let last = process.hrtime.bigint();
let resolution = null;
for (let index = 0; index < 2048; index += 1) {
  const current = process.hrtime.bigint();
  const delta = current - last;
  if (delta > 0n && (resolution === null || delta < resolution)) resolution = delta;
  last = current;
}
process.stdout.write(`${JSON.stringify({ clockSource: 'process.hrtime.bigint', resolutionNs: resolution?.toString() ?? '0' })}\n`);
input.on('line', (line) => {
  if (line === 'quit') { input.close(); return; }
  if (line === 'ping') process.stdout.write(`${process.hrtime.bigint().toString()}\n`);
});
"""


class ClockPing(TypedDict):
    parentSendNs: str
    childMonotonicNs: str
    parentReceiveNs: str


class ClockWindow(TypedDict):
    bootId: str
    parentClockSource: str
    parentResolutionNs: str
    childClockSource: str
    childResolutionNs: str
    pings: list[ClockPing]


class ProbeResult(TypedDict):
    phase: str
    probePid: int
    probeStartTicks: str
    clockWindow: ClockWindow


class ChildClockMetadata(TypedDict):
    clockSource: str
    resolutionNs: str


class ProbeEnvironment(TypedDict, total=False):
    PATH: str
    HOME: str
    LANG: str
    LC_ALL: str
    TMPDIR: str


class ClockProbeError(RuntimeError):
    """A bounded failure while observing a dedicated clock-probe child."""

    def __init__(self, reason_code: str) -> None:
        self.reason_code = reason_code
        super().__init__(reason_code)


def process_start_ticks(pid: int) -> str:
    """Read the Linux process start tick used to disambiguate PID reuse."""
    stat_path = Path(f'/proc/{pid}/stat')
    stat_text = stat_path.read_text(encoding='utf-8')
    delimiter = stat_text.rfind(') ')
    if delimiter < 0:
        raise ClockProbeError('process_identity_unavailable')
    fields = stat_text[delimiter + 2:].split()
    if len(fields) <= 19 or not fields[19].isdigit() or fields[19] == '0':
        raise ClockProbeError('process_identity_unavailable')
    return fields[19]


def read_child_line(child: subprocess.Popen[str]) -> str:
    """Read one bounded response line from the clock-only Node child."""
    if child.stdout is None:
        raise ClockProbeError('child_pipe_unavailable')
    ready, _, _ = select.select([child.stdout], [], [], LINE_TIMEOUT_SECONDS)
    if not ready:
        raise ClockProbeError('child_ping_timeout')
    line = child.stdout.readline()
    if line == '':
        raise ClockProbeError('child_exited')
    return line


def parse_child_metadata(line: str) -> ChildClockMetadata:
    """Parse the Node probe's single bounded metadata record."""
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise ClockProbeError('invalid_child_metadata') from error
    if not isinstance(value, dict):
        raise ClockProbeError('invalid_child_metadata')
    clock_source = value.get('clockSource')
    resolution = value.get('resolutionNs')
    if (not isinstance(clock_source, str) or clock_source != 'process.hrtime.bigint'
        or not isinstance(resolution, str) or not resolution.isdigit() or resolution == '0'):
        raise ClockProbeError('invalid_child_metadata')
    return {'clockSource': clock_source, 'resolutionNs': resolution}


def environment_for_probe() -> ProbeEnvironment:
    """Keep the clock probe isolated from inherited profiler/request settings."""
    environment: ProbeEnvironment = {'PATH': os.environ.get('PATH', '')}
    home = os.environ.get('HOME')
    language = os.environ.get('LANG')
    locale = os.environ.get('LC_ALL')
    temporary_directory = os.environ.get('TMPDIR')
    if home is not None:
        environment['HOME'] = home
    if language is not None:
        environment['LANG'] = language
    if locale is not None:
        environment['LC_ALL'] = locale
    if temporary_directory is not None:
        environment['TMPDIR'] = temporary_directory
    return environment


def run_clock_probe(node_executable: Path, phase: str) -> ProbeResult:
    """Collect send/child/receive monotonic samples without running a benchmark."""
    if not node_executable.is_absolute() or not node_executable.is_file() or not os.access(node_executable, os.X_OK):
        raise ClockProbeError('invalid_node_executable')
    if phase not in ('start', 'end'):
        raise ClockProbeError('invalid_phase')

    boot_id = Path('/proc/sys/kernel/random/boot_id').read_text(encoding='utf-8').strip()
    if boot_id == '':
        raise ClockProbeError('boot_id_unavailable')
    parent_resolution = max(1, round(time.clock_getres(time.CLOCK_MONOTONIC) * 1_000_000_000))
    child = subprocess.Popen(
        [str(node_executable), '-e', NODE_PROBE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding='utf-8',
        bufsize=1,
        env=environment_for_probe(),
    )
    pings: list[ClockPing] = []
    try:
        metadata = parse_child_metadata(read_child_line(child))
        if child.stdin is None:
            raise ClockProbeError('child_pipe_unavailable')
        for _ in range(PING_COUNT):
            parent_send = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
            child.stdin.write('ping\n')
            child.stdin.flush()
            response = read_child_line(child).strip()
            parent_receive = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
            if not response.isdigit():
                raise ClockProbeError('invalid_child_ping')
            pings.append({
                'parentSendNs': str(parent_send),
                'childMonotonicNs': response,
                'parentReceiveNs': str(parent_receive),
            })
        return {
            'phase': phase,
            'probePid': child.pid,
            'probeStartTicks': process_start_ticks(child.pid),
            'clockWindow': {
                'bootId': boot_id,
                'parentClockSource': 'time.clock_gettime_ns:CLOCK_MONOTONIC',
                'parentResolutionNs': str(parent_resolution),
                'childClockSource': metadata['clockSource'],
                'childResolutionNs': metadata['resolutionNs'],
                'pings': pings,
            },
        }
    finally:
        if child.stdin is not None and child.poll() is None:
            try:
                child.stdin.write('quit\n')
                child.stdin.flush()
                child.stdin.close()
            except BrokenPipeError:
                if child.poll() is None:
                    child.terminate()
        try:
            child.wait(timeout=LINE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=LINE_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main(arguments: list[str]) -> int:
    """Run a clock-only calibration phase and emit one machine-readable record."""
    if len(arguments) != 3:
        sys.stderr.write('usage: clock_conformance.py NODE_EXECUTABLE start|end\n')
        return 2
    try:
        result = run_clock_probe(Path(arguments[1]), arguments[2])
    except (ClockProbeError, OSError, subprocess.SubprocessError) as error:
        reason_code = error.reason_code if isinstance(error, ClockProbeError) else 'clock_probe_failed'
        sys.stderr.write(f'clock_probe_failed:{reason_code}\n')
        return 1
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
