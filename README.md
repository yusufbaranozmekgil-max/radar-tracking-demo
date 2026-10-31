# Radar Tracking Simulator

A multi-target radar tracker written in C++20, compiled to WebAssembly so it runs live in your browser.

**[Open the live demo](https://yusufbaranozmekgil-max.github.io/radar-tracking-demo/)**

Change the detection probability, the number of false alarms and the confirmation rule, then watch how the tracker responds.

This repository holds the demo page and the compiled tracker. **The source code is private.**

All data is synthetic. The project uses no real sensor data and models no real system.

## How it works

Each scan predicts every track with a Kalman filter, gates detections by Mahalanobis distance, pairs tracks and detections with the Hungarian algorithm, updates matched tracks, then opens, confirms and deletes tracks with an M-of-N rule.

## Measured results

Five targets over 200 scans, 10 seeds per row, native build. One target turns and two cross at the same point.

| Detection | False alarms / scan | Confirm | Followed | Position error | False tracks / scan |
|---|---|---|---|---|---|
| 90% | 5 | 3 of 5 | 100% | 39 m | 0.00 |
| 90% | 50 | 3 of 5 | 100% | 40 m | 0.11 |
| 90% | 500 | 3 of 5 | 100% | 40 m | 39.14 |
| 90% | 500 | 5 of 7 | 100% | 40 m | 0.01 |
| 60% | 50 | 3 of 5 | 95.3% | 49 m | 0.11 |
| 50% | 50 | 3 of 5 | 85.4% | 59 m | 0.14 |

## Limits

- Results come from synthetic data only.
- A single constant velocity model lags sharp manoeuvres.
- Global nearest neighbour cannot revise an earlier decision.
- Timings came from one desktop core.

Built by Yusuf Baran Ozmakgil.
