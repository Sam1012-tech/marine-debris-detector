# Sample sonar imagery

Real side-scan sonar images live here — no procedural/placeholder tiles are
referenced by the app anymore. `src/api/mockData.js` points at these by
filename and pairs each with the real detections the backend produced when
run through the actual `crab_pot`/`shipwreck`/`mine` models (see that file's
header comment for how to regenerate). `SonarCanvas` still has a procedural
fallback, but only as a last resort if a referenced file goes missing or
fails to load — it is not used for any of the current seed data.

**The box overlay adapts to each image's real aspect ratio automatically** —
portrait, landscape, square all work, nothing needs to be pre-cropped or
resized.

This is the *only* folder the frontend reads sample images from —
`backend/annotations/images/` looks similar but is the opposite direction:
it's where the annotation tool *writes* confirmed/operator-drawn training
images to, not somewhere to drop images for display.

Current files, all referenced from `mockData.js`:

| File | Scan line |
|---|---|
| `sss-mine11.jpg` | L-198 |
| `sss-crabpot1.jpg` | L-203 |
| `sss-rod-boat7.jpg` | L-193 |
| `sss-debris9-nice.jpg` | L-194 |
| `sss3.jpg` | L-195 |
| `sss-bicycle5.jpg` | L-196 |
| `sss2.jpg` | L-197 |
| `sss1.jpg` | L-199 |
| `sss-anchor6.jpg` | L-200 (no detections) |
| `sss-mine4.jpg` | L-201 (no detections) |
| `sss-tires8.jpg` | L-202 (no detections) |

Table order matches `scanLines` order in `mockData.js`, not filename/line-number order.

`shipwreck1.jpeg` and `shipwreck2.jpeg` are also here, deliberately not
wired into `mockData.js` — kept as-is for manually testing the real Upload
flow instead of showing up as pre-seeded demo lines.

Drop any additional image here (`.png`/`.jpg`/`.jpeg`) and add a matching
entry to `scanLines` in `mockData.js` to wire it up — or just run it through
the real Upload page once the backend is running, which needs no manual
wiring at all.
