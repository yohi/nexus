import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const MAX_CONTROL_BYTES = 64 * 1024;
const uuidSchema = z.string().uuid();

export const scenarioRequestSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal('scenario'),
  runId: uuidSchema,
  ownerRoot: z.string().refine(isAbsolute),
  resultFile: z.string().refine(isAbsolute),
  phaseFile: z.string().refine(isAbsolute),
  deadlineEpochMs: z.number().finite().positive(),
  memoryLimitMb: z.literal(2_048),
  timeoutMs: z.literal(600_000),
  options: z.object({
    profile: z.literal('medium'),
    outputMode: z.literal('file'),
    revision: z.object({ commit: z.string().nullable(), dirty: z.boolean().nullable() }).strict(),
    timeoutMs: z.literal(600_000),
    auditPageSize: z.literal(512),
    cacheSeedBatchSize: z.literal(512),
    memoryLimitMb: z.literal(2_048),
    sampleMode: z.literal('full'),
  }).strict(),
  job: z.object({ id: z.literal('cold_initial_index-0'), kind: z.literal('cold_initial_index'), repeat: z.literal(0) }).strict(),
}).strict();

export const diagnosticRequestSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: uuidSchema,
  jobId: z.literal('cold_initial_index'),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runDirectory: z.string().refine(isAbsolute),
  operationId: z.string().regex(/^op_[a-f0-9]{16,64}$/),
  attemptId: z.string().regex(/^attempt_[1-9][0-9]{0,15}$/),
}).strict();

export const profilerRequestSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: uuidSchema,
  jobId: z.literal('cold_initial_index'),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runDirectory: z.string().refine(isAbsolute),
  parentPid: z.number().int().positive(),
}).strict();

export const bootstrapStatusSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: uuidSchema,
  jobId: z.literal('cold_initial_index'),
  status: z.enum(['completed', 'failed']),
  exitCode: z.number().int(),
  diagnosticAdmissible: z.literal(false),
  reasonCode: z.literal('vitest_failed').optional(),
}).strict();

export class DiagnosticBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DiagnosticBootstrapError';
    this.code = code;
  }
}

export function inside(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

export async function verifyOwnedDirectory(path) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !isAbsolute(path)) {
    throw new DiagnosticBootstrapError('invalid_run_directory');
  }
  let descriptor;
  try {
    if (await realpath(path) !== resolve(path)) throw new DiagnosticBootstrapError('invalid_run_directory');
    descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = await descriptor.stat();
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()
      || await realpath(`/proc/self/fd/${descriptor.fd}`) !== resolve(path)) {
      throw new DiagnosticBootstrapError('invalid_run_directory');
    }
  } catch (error) {
    if (error instanceof DiagnosticBootstrapError) throw error;
    throw new DiagnosticBootstrapError('invalid_run_directory');
  } finally {
    await descriptor?.close();
  }
}

export async function readPrivateJson(path, ownerRoot) {
  if (!isAbsolute(path) || !inside(ownerRoot, resolve(path))) throw new DiagnosticBootstrapError('invalid_control_file');
  let descriptor;
  try {
    if (await realpath(path) !== resolve(path)) throw new DiagnosticBootstrapError('invalid_control_file');
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [info, canonical] = await Promise.all([
      descriptor.stat(),
      realpath(`/proc/self/fd/${descriptor.fd}`),
    ]);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || canonical !== resolve(path) || info.size > MAX_CONTROL_BYTES) {
      throw new DiagnosticBootstrapError('invalid_control_file');
    }
    try {
      return JSON.parse(await descriptor.readFile('utf8'));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new DiagnosticBootstrapError('invalid_control_file');
    }
  } catch (error) {
    if (error instanceof DiagnosticBootstrapError) throw error;
    throw new DiagnosticBootstrapError('invalid_control_file');
  } finally {
    await descriptor?.close();
  }
}

export async function ensurePathAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new DiagnosticBootstrapError('diagnostic_output_path_unavailable');
  }
  throw new DiagnosticBootstrapError('diagnostic_output_path_exists');
}

export async function writePrivateJson(path, ownerRoot, value) {
  if (!inside(ownerRoot, resolve(path))) throw new DiagnosticBootstrapError('diagnostic_output_path_invalid');
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTROL_BYTES) throw new DiagnosticBootstrapError('diagnostic_output_too_large');
  let descriptor;
  try {
    descriptor = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = await descriptor.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || await realpath(`/proc/self/fd/${descriptor.fd}`) !== resolve(path)) {
      throw new DiagnosticBootstrapError('diagnostic_output_ownership_invalid');
    }
    await descriptor.writeFile(content, 'utf8');
    await descriptor.sync();
  } catch (error) {
    if (error instanceof DiagnosticBootstrapError) throw error;
    throw new DiagnosticBootstrapError('diagnostic_output_write_failed');
  } finally {
    await descriptor?.close();
  }
}

export function profileRequestPath(environment) {
  const path = environment.NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE;
  if (path === undefined || path.length === 0 || !isAbsolute(path)) {
    throw new DiagnosticBootstrapError('diagnostic_profile_request_path_missing');
  }
  return resolve(path);
}

export function quoteNodeOption(path) {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
