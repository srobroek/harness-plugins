---
description: Review a rendered surface with design-critic and a11y-auditor in parallel, then reconcile their verdicts
argument-hint: "<url-or-route> [changed paths] [--widths 1440,768,375]"
---

Review the rendered surface the user names at the end of this prompt. If the user gave no URL or route, ask for one.

1. Confirm the surface responds. When it needs a dev server, start it once as a background shell process and reuse it. Note the served URL.
2. Collect the brief: the URL, the changed paths the user gave (else none), the widths (default 1440, 768 and 375), and the project's token file paths.
3. Run `design_impeccable_scan` once on the URL or the changed paths. When it refuses or fails, record why and continue without detector output.
4. Launch `design-critic` and `a11y-auditor` in ONE parallel `subagent` call with `async: true`, each briefed with the URL, the changed paths, the widths, the token paths and the detector JSON. They drive the package's Playwright browser, which pi starts only for background children.
5. When both reports are back, reconcile them: merge findings with one root cause, keep the accessibility verdict apart from the visual verdict, and mark each finding as measured by the child or unverified.
6. Report the served URL, both verdicts, and the merged findings worst first, each with its width and measured value. Do not edit files unless the user asks for fixes.

Surface and options:

$@
