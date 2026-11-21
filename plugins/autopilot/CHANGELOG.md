## autopilot 1.0.0 (2026-11-21)

### Features

* **autopilot:** unattended runs with a journal, a 4-minute tick and stop conditions ([2081cc8](https://github.com/srobroek/harness-plugins/commit/2081cc85effd8eb9ff671d5e1de90197451c4a51))

### Bug Fixes

* **autopilot:** close gate bypasses, fence state writes atomically, bind ticks, retry stop artifacts ([85ddd9b](https://github.com/srobroek/harness-plugins/commit/85ddd9b6fdbf6205c85c609b20b46726ef0a015b))
* **autopilot:** close permission bypasses, serialize run state and keep tick signals ([0aa467a](https://github.com/srobroek/harness-plugins/commit/0aa467aa70d3725c848a23ac7c59b28e97913d34))
* **autopilot:** decode only git command words, synchronize the resume race test ([c7332d7](https://github.com/srobroek/harness-plugins/commit/c7332d77b09393671a73c49f77f03d4860faa5e7))
* **autopilot:** decode quoted refspecs, rebind resume under the run lock, report incomplete reads ([6aed858](https://github.com/srobroek/harness-plugins/commit/6aed8587d64b6f0829fccccb46bd3b9b0e0629d0))
* **autopilot:** deny every permission ask while armed, own the state write lock, keep the handoff pending on a failed lookup ([56ffe32](https://github.com/srobroek/harness-plugins/commit/56ffe32e29ae60de3d8f230c97d98733b37ffb20))
* **autopilot:** fail-closed permission gate, fenced run state under a file lock, strict run file reads ([6366fe9](https://github.com/srobroek/harness-plugins/commit/6366fe99280d93801a28200d7d8c525b0811260a))
* **autopilot:** store run state as versioned, create-exclusive generation files ([2be1532](https://github.com/srobroek/harness-plugins/commit/2be1532333e876291371d93fa02c78915ee3ee6e))
