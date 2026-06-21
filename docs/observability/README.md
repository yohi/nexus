# Nexus Observability Setup Guide

This guide describes how to configure Prometheus and Grafana to scrape merged metrics from the Nexus Aggregator.

## How it works

1. Multiple Nexus server processes register themselves with the Dashboard CLI's central Aggregator.
2. The Aggregator runs on port `9470` by default.
3. Scraping `localhost:9470/metrics` collects merged, label-isolated metrics from all registered processes.

## Prometheus Configuration

Add the following scrape configuration to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'nexus'
    scrape_interval: 10s
    static_configs:
      - targets: ['localhost:9470']
```

## Grafana Dashboard Import

Import the JSON file at `docs/observability/grafana-dashboard.json` into Grafana:
1. Open Grafana Dashboard.
2. Click **Dashboards** -> **New** -> **Import**.
3. Upload `grafana-dashboard.json`.
4. Choose the appropriate Prometheus datasource. (Note: If the datasource variable does not resolve automatically, manually select your Prometheus datasource during import.)

## Metrics Index (Full Catalog)

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `nexus_event_queue_size` | Gauge | `project`, `pid`, `queue_id` | Current event queue size |
| `nexus_event_queue_state` | Gauge | `project`, `pid`, `queue_id`, `state` | Current backpressure state (1 = active) |
| `nexus_event_queue_dropped_total` | Counter | `project`, `pid`, `queue_id` | Total dropped events due to overflow |
| `nexus_indexing_chunks_total` | Counter | `project`, `pid` | Total chunks indexed |
| `nexus_reindex_duration_seconds` | Histogram | `project`, `pid`, `full_rebuild` | Duration of reindex runs |
| `nexus_dlq_size` | Gauge | `project`, `pid`, `dlq_id` | Current DLQ entry count |
| `nexus_dlq_recovery_total` | Counter | `project`, `pid`, `dlq_id`, `result` | DLQ recovery sweep results |
| `nexus_indexing_active` | Gauge | `project`, `pid` | Whether indexing run is active (1 = active) |
| `nexus_indexing_processed_files` | Gauge | `project`, `pid` | Processed files count in current run |
| `nexus_indexing_total_files` | Gauge | `project`, `pid` | Total files to process in current run |
| `nexus_tool_calls_total` | Counter | `project`, `pid`, `tool_name`, `status` | Cumulative tool calls count |
| `nexus_tool_duration_seconds` | Histogram | `project`, `pid`, `tool_name` | Latency distribution of tool calls |
| `nexus_search_results_hits` | Histogram | `project`, `pid`, `search_type` | Hits count per search query |
| `nexus_context_lines_fetched_total` | Counter | `project`, `pid`, `tool_name` | Cumulative lines fetched by code viewer |
| `nexus_embedding_requests_total` | Counter | `project`, `pid`, `provider`, `status` | Embedding provider requests count |
| `nexus_embedding_duration_seconds` | Histogram | `project`, `pid`, `provider` | Embedding request latency |
| `nexus_embedding_batch_size` | Histogram | `project`, `pid`, `provider` | Embedding request batch size distribution |
