import { describe, it, expect } from 'vitest';
import { serializeToPrometheus } from '../../src/server/aggregator.js';

describe('serializeToPrometheus', () => {
  it('merges metrics from multiple sources grouping by metric name', () => {
    const source1 = [
      {
        name: 'nexus_tool_calls_total',
        help: 'Total tool calls count',
        type: 'counter',
        values: [
          { value: 10, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search', status: 'success' } }
        ]
      }
    ];

    const source2 = [
      {
        name: 'nexus_tool_calls_total',
        help: 'Total tool calls count',
        type: 'counter',
        values: [
          { value: 5, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search', status: 'success' } }
        ]
      }
    ];

    const output = serializeToPrometheus([source1, source2]);
    expect(output).toContain('# HELP nexus_tool_calls_total Total tool calls count');
    expect(output).toContain('# TYPE nexus_tool_calls_total counter');
    expect(output).toContain('nexus_tool_calls_total{project="foo",pid="123",tool_name="hybrid_search",status="success"} 10');
    expect(output).toContain('nexus_tool_calls_total{project="bar",pid="456",tool_name="hybrid_search",status="success"} 5');
  });

  it('escapes Prometheus label values', () => {
    const source = [
      {
        name: 'nexus_tool_calls_total',
        help: 'Total tool calls count',
        type: 'counter',
        values: [
          { value: 1, labels: { project: 'foo"bar', pid: '123\\456', tool_name: 'line\nbreak', status: 'success' } }
        ]
      }
    ];

    const output = serializeToPrometheus([source]);
    expect(output).toContain('project="foo\\"bar"');
    expect(output).toContain('pid="123\\\\456"');
    expect(output).toContain('tool_name="line\\nbreak"');
  });

  it('sorts metric groups by metric name for stable output', () => {
    const source = [
      {
        name: 'z_metric_total',
        help: 'Z metric',
        type: 'counter',
        values: [{ value: 1, labels: {} }]
      },
      {
        name: 'a_metric_total',
        help: 'A metric',
        type: 'counter',
        values: [{ value: 1, labels: {} }]
      }
    ];

    const output = serializeToPrometheus([source]);
    expect(output.indexOf('# HELP a_metric_total')).toBeLessThan(output.indexOf('# HELP z_metric_total'));
  });

  it('handles histogram metrics correctly combining buckets, sum, and count from multiple sources with order validation', () => {
    const source1 = [
      {
        name: 'nexus_tool_duration_seconds',
        help: 'Tool execution duration',
        type: 'histogram',
        values: [
          { value: 2, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search', le: '0.1' }, metricName: 'nexus_tool_duration_seconds_bucket' },
          { value: 1.25, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_sum' },
          { value: 2, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_count' }
        ]
      }
    ];

    const source2 = [
      {
        name: 'nexus_tool_duration_seconds',
        help: 'Tool execution duration',
        type: 'histogram',
        values: [
          { value: 1, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search', le: '0.1' }, metricName: 'nexus_tool_duration_seconds_bucket' },
          { value: 0.05, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_sum' },
          { value: 1, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_count' }
        ]
      }
    ];

    const output = serializeToPrometheus([source1, source2]);
    expect(output).toContain('# HELP nexus_tool_duration_seconds Tool execution duration');
    expect(output).toContain('# TYPE nexus_tool_duration_seconds histogram');
    
    // Validate value presence
    expect(output).toContain('nexus_tool_duration_seconds_bucket{project="foo",pid="123",tool_name="hybrid_search",le="0.1"} 2');
    expect(output).toContain('nexus_tool_duration_seconds_sum{project="foo",pid="123",tool_name="hybrid_search"} 1.25');
    expect(output).toContain('nexus_tool_duration_seconds_count{project="foo",pid="123",tool_name="hybrid_search"} 2');
    
    expect(output).toContain('nexus_tool_duration_seconds_bucket{project="bar",pid="456",tool_name="hybrid_search",le="0.1"} 1');
    expect(output).toContain('nexus_tool_duration_seconds_sum{project="bar",pid="456",tool_name="hybrid_search"} 0.05');
    expect(output).toContain('nexus_tool_duration_seconds_count{project="bar",pid="456",tool_name="hybrid_search"} 1');

    // Validate correct ordering (HELP -> TYPE -> values, and values: bucket -> sum -> count)
    const posHelp = output.indexOf('# HELP nexus_tool_duration_seconds');
    const posType = output.indexOf('# TYPE nexus_tool_duration_seconds');
    const posBucketFoo = output.indexOf('nexus_tool_duration_seconds_bucket{project="foo"');
    const posSumFoo = output.indexOf('nexus_tool_duration_seconds_sum{project="foo"');
    const posCountFoo = output.indexOf('nexus_tool_duration_seconds_count{project="foo"');

    expect(posHelp).toBeLessThan(posType);
    expect(posType).toBeLessThan(posBucketFoo);
    expect(posBucketFoo).toBeLessThan(posSumFoo);
    expect(posSumFoo).toBeLessThan(posCountFoo);
  });
});
