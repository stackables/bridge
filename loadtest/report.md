# Bridge Engine — Performance Report

Automated benchmark comparing Bridge's declarative execution engine against hand-coded Node.js.
All three implementations serve the same API endpoints, fetching from an identical dependency backend.

## 1. Latency Overhead

Measured at **20 VUs** on the `array` scenario (1,000-item array with field renaming).
This isolates pure engine overhead — the same HTTP call, the same data, only the processing layer differs.

| Implementation          |     Avg |     p50 |      p90 |      p95 |      p99 |
| ----------------------- | ------: | ------: | -------: | -------: | -------: |
| **Hand-coded Node.js**  |  8.5 ms |  8.1 ms |  10.6 ms |  11.8 ms |  14.8 ms |
| **Bridge (Standalone)** | 13.9 ms | 13.6 ms |  16.1 ms |  17.1 ms |  25.0 ms |
| **Bridge (Compiler)**   |  8.3 ms |  8.0 ms |   9.4 ms |  10.1 ms |  13.7 ms |
| **Bridge (GraphQL)**    | 89.8 ms | 89.2 ms | 109.9 ms | 118.1 ms | 135.5 ms |

> Bridge Standalone adds **~5.4 ms** avg compared to hand-coded Node.js.

## 2. Per-Scenario Breakdown

All scenarios at **20 VUs**. Simple = 1 fetch + 7 field mappings. Array = 1 fetch + 1,000 items × 4 fields. Complex = 3 parallel fetches + array mapping + field merging.

### Simple

| Implementation          |     Avg |      p95 |      p99 |
| ----------------------- | ------: | -------: | -------: |
| **Hand-coded Node.js**  |  8.0 ms |  11.3 ms |  14.2 ms |
| **Bridge (Standalone)** | 13.0 ms |  16.0 ms |  24.4 ms |
| **Bridge (Compiler)**   |  7.7 ms |   9.6 ms |  12.6 ms |
| **Bridge (GraphQL)**    | 88.6 ms | 116.3 ms | 137.4 ms |

### Array Map

| Implementation          |     Avg |      p95 |      p99 |
| ----------------------- | ------: | -------: | -------: |
| **Hand-coded Node.js**  |  8.5 ms |  11.8 ms |  14.8 ms |
| **Bridge (Standalone)** | 13.9 ms |  17.1 ms |  25.0 ms |
| **Bridge (Compiler)**   |  8.3 ms |  10.1 ms |  13.7 ms |
| **Bridge (GraphQL)**    | 89.8 ms | 118.1 ms | 135.5 ms |

### Complex

| Implementation          |     Avg |      p95 |      p99 |
| ----------------------- | ------: | -------: | -------: |
| **Hand-coded Node.js**  |  8.5 ms |  12.0 ms |  15.4 ms |
| **Bridge (Standalone)** | 13.6 ms |  16.9 ms |  25.3 ms |
| **Bridge (Compiler)**   |  8.2 ms |  10.2 ms |  14.1 ms |
| **Bridge (GraphQL)**    | 95.8 ms | 123.9 ms | 145.7 ms |

## 3. Throughput Under Load

Requests per second on the `complex` scenario (the heaviest workload) as concurrency increases.

| Load (VUs)  | Hand-coded Node.js | Bridge (Standalone) | Bridge (Compiler) | Bridge (GraphQL) |
| ----------- | -----------------: | ------------------: | ----------------: | ---------------: |
| **20 VUs**  |                799 |                 492 |               823 |               71 |
| **50 VUs**  |                816 |                 481 |               792 |               72 |
| **100 VUs** |                783 |                 459 |               793 |               74 |
| **200 VUs** |                785 |                 435 |               736 |               74 |

> At 200 VUs, Bridge Standalone maintains **56%** of hand-coded throughput.

## 4. Methodology

All tests run inside Docker containers on the same host, communicating over a Docker bridge network.

Each target is tested **sequentially** — only one receives load at any time,
giving it 100% of available CPU and memory. This eliminates resource contention
between services and produces accurate, reproducible numbers.

- **OS / Arch:** MacBook Air M4 (4th gen, 15″) with Docker desktop
- **Load generator:** [k6](https://k6.io) (containerised)
- **Per-target warmup:** 10 s at 10 VUs (excluded from results)
- **Stages:** 20 VUs → 50 VUs → 100 VUs → 200 VUs (30 s each per target)
- **Dependency:** nginx serving pre-generated static JSON (zero compute)
