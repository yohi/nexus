import { z } from 'zod';

export type ClockPing = Readonly<{
  parentSendNs: bigint;
  childMonotonicNs: bigint;
  parentReceiveNs: bigint;
}>;

export type ClockPingWindow = Readonly<{
  bootId: string;
  parentClockSource: string;
  parentResolutionNs: bigint;
  childClockSource: string;
  childResolutionNs: bigint;
  pings: readonly ClockPing[];
}>;

const clockPingWindowSchema = z.object({
  bootId: z.string().min(1).max(64),
  parentClockSource: z.string().min(1).max(128),
  parentResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  childClockSource: z.string().min(1).max(128),
  childResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  pings: z.array(z.object({
    parentSendNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
    childMonotonicNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
    parentReceiveNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
  }).strict()).min(3).max(64),
}).strict();

export function parseClockPingWindow(value: unknown): ClockPingWindow {
  const parsed = clockPingWindowSchema.parse(value);
  return Object.freeze({
    bootId: parsed.bootId,
    parentClockSource: parsed.parentClockSource,
    parentResolutionNs: BigInt(parsed.parentResolutionNs),
    childClockSource: parsed.childClockSource,
    childResolutionNs: BigInt(parsed.childResolutionNs),
    pings: Object.freeze(parsed.pings.map((ping) => Object.freeze({
      parentSendNs: BigInt(ping.parentSendNs),
      childMonotonicNs: BigInt(ping.childMonotonicNs),
      parentReceiveNs: BigInt(ping.parentReceiveNs),
    }))),
  });
}

export type ClockMappingInput = Readonly<{
  start: ClockPingWindow;
  end: ClockPingWindow;
  parentClockDomain: string;
  childClockDomain: string;
}>;

export type ClockOffsetInterval = Readonly<{ lowerNs: string; upperNs: string }>;

export type ClockMappingResult =
  | Readonly<{
    status: 'aligned';
    clockDomain: 'linux_clock_monotonic_ns';
    offsetConvention: 'parent_minus_child';
  bootId: string;
  parentClockSource: string;
  parentResolutionNs: string;
  childClockSource: string;
  childResolutionNs: string;
  startOffset: ClockOffsetInterval;
  endOffset: ClockOffsetInterval;
  combinedUncertaintyNs: string;
  startParentResolutionNs: string;
  endParentResolutionNs: string;
  startChildResolutionNs: string;
  endChildResolutionNs: string;
  }>
  | Readonly<{
    status: 'not_correlatable';
    reasonCode: 'clock_domain_mismatch' | 'boot_id_changed' | 'invalid_ping' | 'insufficient_pings'
      | 'offset_intervals_do_not_overlap' | 'uncertainty_exceeded' | 'clock_source_changed' | 'invalid_clock_metadata'
      | 'invalid_ping_count';
  }>;

type InternalInterval = Readonly<{ lowerNs: bigint; upperNs: bigint }>;

const REQUIRED_PINGS = 3;
const MAX_COMBINED_UNCERTAINTY_NS = 10_000_000n;

function deriveMinimumRttInterval(pings: readonly ClockPing[]): InternalInterval | ClockMappingResult {
  if (pings.length > 64) return { status: 'not_correlatable', reasonCode: 'invalid_ping_count' };
  if (pings.some((ping) => ping.parentSendNs < 0n || ping.childMonotonicNs < 0n
    || ping.parentReceiveNs < ping.parentSendNs)) {
    return { status: 'not_correlatable', reasonCode: 'invalid_ping' };
  }
  if (pings.length < REQUIRED_PINGS) return { status: 'not_correlatable', reasonCode: 'insufficient_pings' };

  const roundTrips = pings.map((ping) => ping.parentReceiveNs - ping.parentSendNs);
  const minimumRoundTrip = roundTrips.reduce((minimum, roundTrip) => roundTrip < minimum ? roundTrip : minimum);
  const minimumPings = pings.filter((_, index) => roundTrips[index] === minimumRoundTrip);
  const firstMinimumPing = minimumPings.at(0);
  if (firstMinimumPing === undefined) return { status: 'not_correlatable', reasonCode: 'insufficient_pings' };
  const lowerNs = minimumPings.reduce((maximum, ping) => {
    const offset = ping.parentSendNs - ping.childMonotonicNs;
    return offset > maximum ? offset : maximum;
  }, firstMinimumPing.parentSendNs - firstMinimumPing.childMonotonicNs);
  const upperNs = minimumPings.reduce((minimum, ping) => {
    const offset = ping.parentReceiveNs - ping.childMonotonicNs;
    return offset < minimum ? offset : minimum;
  }, firstMinimumPing.parentReceiveNs - firstMinimumPing.childMonotonicNs);
  if (lowerNs > upperNs) return { status: 'not_correlatable', reasonCode: 'offset_intervals_do_not_overlap' };
  return { lowerNs, upperNs };
}

function isFailure(interval: InternalInterval | ClockMappingResult): interval is ClockMappingResult {
  return 'status' in interval;
}

export function calibrateClockMapping(input: ClockMappingInput): ClockMappingResult {
  if (input.parentClockDomain !== 'linux_clock_monotonic_ns'
    || input.childClockDomain !== 'process_local_monotonic') {
    return { status: 'not_correlatable', reasonCode: 'clock_domain_mismatch' };
  }
  if (input.start.bootId.length === 0 || input.start.bootId !== input.end.bootId) {
    return { status: 'not_correlatable', reasonCode: 'boot_id_changed' };
  }
  if (input.start.parentClockSource.length === 0 || input.start.childClockSource.length === 0
    || input.start.parentClockSource !== input.end.parentClockSource
    || input.start.childClockSource !== input.end.childClockSource) {
    return { status: 'not_correlatable', reasonCode: 'clock_source_changed' };
  }
  if (input.start.parentResolutionNs <= 0n || input.start.childResolutionNs <= 0n
    || input.end.parentResolutionNs <= 0n || input.end.childResolutionNs <= 0n) {
    return { status: 'not_correlatable', reasonCode: 'invalid_clock_metadata' };
  }

  const start = deriveMinimumRttInterval(input.start.pings);
  if (isFailure(start)) return start;
  const end = deriveMinimumRttInterval(input.end.pings);
  if (isFailure(end)) return end;

  if (start.lowerNs > end.upperNs || end.lowerNs > start.upperNs) {
    return { status: 'not_correlatable', reasonCode: 'offset_intervals_do_not_overlap' };
  }
  const startResolution = input.start.parentResolutionNs > input.start.childResolutionNs
    ? input.start.parentResolutionNs : input.start.childResolutionNs;
  const endResolution = input.end.parentResolutionNs > input.end.childResolutionNs
    ? input.end.parentResolutionNs : input.end.childResolutionNs;
  const combinedUncertainty = (start.upperNs - start.lowerNs) + (end.upperNs - end.lowerNs)
    + startResolution + endResolution;
  if (combinedUncertainty > MAX_COMBINED_UNCERTAINTY_NS) {
    return { status: 'not_correlatable', reasonCode: 'uncertainty_exceeded' };
  }

  return {
    status: 'aligned',
    clockDomain: 'linux_clock_monotonic_ns',
    offsetConvention: 'parent_minus_child',
    bootId: input.start.bootId,
    parentClockSource: input.start.parentClockSource,
    parentResolutionNs: input.start.parentResolutionNs.toString(),
    childClockSource: input.start.childClockSource,
    childResolutionNs: input.start.childResolutionNs.toString(),
    startOffset: { lowerNs: start.lowerNs.toString(), upperNs: start.upperNs.toString() },
    endOffset: { lowerNs: end.lowerNs.toString(), upperNs: end.upperNs.toString() },
    combinedUncertaintyNs: combinedUncertainty.toString(),
    startParentResolutionNs: input.start.parentResolutionNs.toString(),
    endParentResolutionNs: input.end.parentResolutionNs.toString(),
    startChildResolutionNs: input.start.childResolutionNs.toString(),
    endChildResolutionNs: input.end.childResolutionNs.toString(),
  };
}
