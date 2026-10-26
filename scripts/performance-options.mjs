const deadlines = Object.freeze({ smoke: 120_000, small: 120_000, medium: 600_000, large: 1_800_000 });

export function parsePerformanceOptions(args) {
  const values = { profile: 'small', output: undefined, timeoutMs: undefined, memoryLimitMb: 2_048 };
  let error;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--profile', '--output', '--timeout-ms', '--memory-limit-mb'].includes(flag)) { error ??= 'invalid_option'; continue; }
    if (seen.has(flag)) error ??= 'duplicate_option';
    seen.add(flag);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) { error ??= 'missing_option_value'; continue; }
    index += 1;
    switch (flag) {
      case '--profile':
        if (Object.hasOwn(deadlines, value)) values.profile = value;
        else error ??= 'invalid_profile';
        break;
      case '--output': values.output = value; break;
      case '--timeout-ms': case '--memory-limit-mb': {
        const number = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > 2_147_483_647) error ??= 'invalid_positive_integer';
        else if (flag === '--timeout-ms') values.timeoutMs = number;
        else values.memoryLimitMb = number;
        break;
      }
    }
  }
  return Object.freeze({ ...values, timeoutMs: values.timeoutMs ?? deadlines[values.profile], valid: error === undefined, error });
}

function optionTokens(value) {
  const tokens = [];
  let token = '';
  let quote;
  for (const character of value) {
    if (quote !== undefined) { token += character; if (character === quote) quote = undefined; }
    else if (character === '"' || character === "'") { token += character; quote = character; }
    else if (/\s/.test(character)) { if (token !== '') { tokens.push(token); token = ''; } }
    else token += character;
  }
  if (token !== '') tokens.push(token);
  return tokens;
}

export function workerNodeOptions(inherited, memoryLimitMb) {
  const tokens = optionTokens(inherited ?? '');
  const kept = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index];
    const token = raw.replace(/^["']|["']$/g, '');
    if (/^--max[-_]old[-_]space[-_]size(?:=|$)/.test(token)) {
      if (!token.includes('=') && index + 1 < tokens.length) index += 1;
    } else kept.push(raw);
  }
  return [...kept, `--max-old-space-size=${memoryLimitMb}`].join(' ');
}

export function performanceJobs(sampleMode) {
  const jobs = [];
  for (let repeat = 0; repeat < (sampleMode === 'full' ? 3 : 1); repeat += 1) {
    for (const kind of ['cold_initial_index', 'l1_replay', 'l2_rebuild', 'warm_restart', 'incremental', 'siblings']) {
      jobs.push({ id: `${kind}-${repeat}`, kind, repeat });
    }
  }
  jobs.push({ id: 'warm-0', kind: 'warm', repeat: 0 }, { id: 'first-call-0', kind: 'first_call', repeat: 0 });
  return jobs;
}
