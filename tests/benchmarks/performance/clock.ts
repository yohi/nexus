import { captureResources } from './resources.js';

export interface Clock { readonly now: () => number; }
export const systemClock: Clock = Object.freeze({ now: () => performance.now() });

export function captureNodeResources(start: NodeJS.CpuUsage,
  cpuScope: 'runtime_to_completion' | 'operation_to_completion' | 'handler_group' | 'setup_to_completion') {
  return captureResources(start, cpuScope);
}
