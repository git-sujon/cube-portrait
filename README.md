# Cube Assembly Portrait

A browser experience built with **three.js** in which thousands of glossy red cubes lie in a heap on a dark floor, charge with red energy, and fly together into a 3D bust of a person, cut out from their portrait photo. When the last cube locks in, the red glow gives way to the photo's real colours and the figure turns slowly above the cubes left on the floor.

No build step, no server, no dependencies to install. Open `index.html` and it runs.

## Quick start

1. Unzip the folder.
2. Double-click `index.html` (or serve the folder with any static server, e.g. `npx serve .`).
3. Click **Use your photo**, or drag an image onto the page.

An internet connection is needed the first time, because three.js and the font load from a CDN. See [Running offline](#running-offline) to remove that.

Your photo is read by the browser only. Nothing is uploaded.

## Files

| File | What it holds |
|---|---|
| `index.html` | Page markup, the CDN `<script>` tags for three.js, and the control bar |
| `style.css` | All styling for the HUD, control bar and sliders (light and dark themes) |
| `main.js` | Everything 3D: scene, shaders, photo sampling, animation loop, UI wiring |
| `default-portrait.js` | The built-in portrait: photo, depth map and relief value as data URIs. Delete the `<script>` tag for it and the page falls back to a drawn sample face |
| `tools/make_depth.py` | Python script that measures a face and writes a depth map + cut-out for any portrait |
| `README.md` | This document |

## Controls

| Control | What it does |
|---|---|
| Use your photo / drag and drop | Rebuilds the cubes from your image and replays the assembly |
| Assemble / Pause / Scatter | Plays, pauses, or reverses the animation. Space bar does the same |
| Scrubber | Drag to move through the assembly by hand |
| Drag on the scene | Orbit the camera. Scroll or pinch to zoom |
| Tune → Cube density | Cubes across the portrait (48–160). More cubes means a sharper face and a heavier scene |
| Tune → Relief depth | How deep the figure is, front to back |
| Tune → Speed | Playback rate |
| Tune → Red energy | Strength of the glow, traces, arcs, bloom and the afterglow band |
| Tune → Remove background | Leaves backdrop cubes on the floor so only the person is built (used when no depth map supplies a cut-out) |
| Tune → Add depth map | Loads a depth image for the current photo (see [Depth maps](#depth-maps)) |

## Libraries

three.js **r128** (0.128.0), loaded as plain `<script>` tags that attach to the global `THREE`:

| Script | Used for |
|---|---|
| `three.min.js` | Core renderer, `InstancedMesh`, `ShaderMaterial` |
| `OrbitControls.js` | Drag-to-orbit camera |
| `EffectComposer.js`, `RenderPass.js`, `ShaderPass.js`, `CopyShader.js` | Post-processing chain |
| `UnrealBloomPass.js`, `LuminosityHighPassShader.js` | Bloom (the glow) |
| `FXAAShader.js` | Anti-aliasing after bloom |

r128 is used because it still ships these add-ons as non-module scripts, so the project needs no bundler. Each add-on is optional at runtime: if one fails to load, the page falls back (no orbit, or a plain render without bloom).

## How it works

### 1. Photo to cube data (`build()` and `analyse()`)

1. The photo is centre-cropped to 4:5 and drawn into a tiny canvas of `cols × rows` pixels, one pixel per cube. Each pixel's RGB becomes that cube's final colour.
2. **Who is in the figure.** A mask decides which cubes fly. It comes from the depth map's alpha channel if there is one; otherwise from a flood fill that eats inward from the frame over anything close to the backdrop colour. Cubes outside the mask get a launch delay they can never reach, so they stay in the heap.
3. **How far forward each cube sits.** Height (0–1) comes from, in order of preference:
   - the **depth map** (white = nearest), which is what makes the built-in portrait a true head shape with a real nose and brow;
   - otherwise an **inflated silhouette**: a distance transform puffs the mask into a rounded bust, with a little brightness detail on top;
   - otherwise (no backdrop found, or Remove background off) plain **brightness**, as a flat relief.
4. Each cube gets a random resting place in the heap (densest and tallest in the middle) and a launch delay. Cubes near the centre of the figure launch first.

All of this is written into per-instance attributes on a single `InstancedMesh`:

| Attribute | Type | Meaning |
|---|---|---|
| `aStart` | vec3 | Resting position in the heap |
| `aTarget` | vec3 | `xy` = grid position in the portrait, `z` = brightness − 0.5 |
| `aColor` | vec4 | `rgb` = photo colour, `a` = how deep in the heap (tilts the resting cube) |
| `aSeed` | vec4 | `x` = launch delay 0–1 (2 = stays on the floor), `yzw` = random numbers |

### 2. Motion on the GPU (vertex shader)

JavaScript only advances one number per frame, `uProgress` (0 = heap, 1 = portrait). The vertex shader turns that into a position for every cube, which is why the frame rate holds with thousands of cubes.

For each cube:

- **Local time** `t = clamp(uProgress·(1+stagger) − delay·stagger, 0, 1)`. Every cube runs the same flight, just offset by its delay.
- **Slide, then climb.** Horizontal travel eases with `e = ease(t)`; vertical travel starts later (`ey`, from `t = 0.22`). Cubes skate inward across the floor before lifting off.
- **Swirl.** The position is rotated around the vertical axis by an angle that shrinks to zero on arrival, giving a spiral path.
- **Tumble.** At rest the cube sits at a random angle. In the air it spins one or two full turns around a random axis, ending exactly square.
- **Column stretch.** Once locked, the back face of the cube is pushed backwards so every cube becomes a column reaching a common back plane. This keeps the figure solid when viewed from the side.
- **Surface jitter.** Each cube sits up to a third of a cube proud or shy of its true height, so the surface reads as cubes, not a smooth photo.

### 3. Look (fragment shader)

- **Bevel:** the surface normal is bent toward the neighbouring face near each edge, so edges catch the light without extra geometry.
- **Reflections:** a tiny procedural "studio" (pale sky, one hot key light, warm horizon, red glow from the floor) is sampled with the reflection vector and weighted by a Fresnel term.
- **Circuit traces:** each face is split into a 4×4 grid; a hash picks a straight run, a corner, a pad or nothing for each cell. Traces pulse along the face.
- **Red glass body:** a per-cube tint between near-black and deep red, lit from inside.
- **Lock-in:** between `t = 0.9` and `1.0` the cube cross-fades from energised glass to photo colour, with a short red flash just before.
- **Settle:** locked cubes stay dim and ember-tinted until the whole face is nearly complete (`uSettle`), then rise to true colour together.
- **Column sides:** the photo colour wraps about one cube down each column so the face holds when the head turns. Deeper down (the outline of the figure) the columns are dark glass with a few live traces.
- **Afterglow:** every few seconds a band of red energy climbs the finished figure. Set Red energy to 0 to switch it off.
- **Distance handling:** `fwidth()` measures how many pixels a cube covers. Small cubes drop the bevel and trace detail to avoid shimmer.

### 4. Scene dressing

- **Floor:** a large disc with a gritty wet sheen and a red pool of light under the heap, fading into haze.
- **Backdrop:** an inside-out sphere with a dark gradient and one soft light spot.
- **Arcs:** `LineSegments` rebuilt about 16 times a second. Each arc starts at a cube in flight and jags a short way toward that cube's destination. The flight path is mirrored in JavaScript (`flight()`) just for this.

### 5. Post-processing and camera

- **Bloom** is strong with a low threshold while cubes fly, then eases down with a high threshold as the portrait settles, so the photo is not washed out.
- **FXAA** runs last to smooth edges.
- **Camera** starts low beside the heap and pulls back to frame the figure, which then turns slowly from side to side. The first drag hands control to you and stops the turn; loading a new photo resets it. Orbit is limited to the front half because the figure has a flat back.

## Depth maps

A depth map is a greyscale image the same shape as the photo: white is nearest the viewer, black is furthest. If it is a PNG with transparency, the transparent area is treated as background.

`tools/make_depth.py` makes one from any portrait:

```
pip install "mediapipe==0.10.14" scipy pillow numpy
python tools/make_depth.py me.png --out-dir out
```

It writes `me_photo.jpg` (the 4:5 crop) and `me_depth.png`, and prints the relief value to set on the slider. Load the photo with **Use your photo**, then the PNG with **Tune → Add depth map**.

What the script does:

1. Cuts the person out with a segmentation model, plus anything that differs from a plain backdrop.
2. Inflates that silhouette into a rounded bust.
3. Fits a 468-point 3D face mesh and uses its measured depth inside the face outline, feathered into the bust.
4. Sets the torso back behind the face and adds a little photo detail.

Add `--js` to also write `default-portrait.js`; drop that file into the project folder to make the portrait the built-in one.

Any other depth source works too (a depth-estimation model, a phone's portrait-mode depth, a hand-painted map), as long as white is near.

## Tuning in code

Constants near the top of `main.js`:

| Constant | Default | Effect |
|---|---|---|
| `FACE_H` | `10` | Portrait height in world units |
| `ASPECT` | `1.25` | Rows ÷ columns (4:5 portrait). Change to `1` for a square crop |
| `BASE_DURATION` | `8` | Seconds for a full assembly at speed 1 |
| `STAGGER` | `1.6` | Spread of launch times. Lower = cubes move together; higher = longer trickle |
| `PILE_R` | `13` | Radius of the heap on the floor |
| `ARCS`, `ARC_SEG` | `26`, `8` | Number of arcs and segments per arc |
| `state.cols` | `120` desktop, `84` phone | Default cube density (this counts floor cubes too) |

Common changes:

- **Different energy colour:** in the cube fragment shader change `red`, `hot` and the two `glass` colours; in the floor shader change the spill colour; change `arcMat`'s `color`.
- **Assemble from the edges inward:** in `build()`, replace `0.6 * d` with `0.6 * (1 - d)` in the launch-delay line.
- **Invert the depth:** in `build()`, store `0.5 - height[i]` in `targets[i * 3 + 2]`.
- **No slow turn at the end:** in the frame loop, change `lerp(0.14, 0.6, settle)` to `0.14`.
- **Flat mosaic, no relief:** set the Relief depth slider (or `state.depth`) to `0`.
- **Autoplay off:** set `state.holdUntil` to `Infinity`.

## Performance notes

- One draw call for all cubes; per-frame CPU work is a few uniforms plus 26 short arcs.
- Pixel ratio is capped at 2 (1.5 on small screens). Bloom is the most expensive part; lowering the cap in `DPR` is the quickest win on weak GPUs.
- Cube density is the other lever. 160 across is 32,000 cubes.
- The page respects "reduce motion": it opens on the finished portrait and does not autoplay or sway.

## Running offline

Download the nine scripts listed in `index.html` from the three.js 0.128.0 package (`npm pack three@0.128.0`, files under `build/` and `examples/js/`), put them in a `vendor/` folder, and point the `<script src>` attributes at the local copies. Remove the Google Fonts `<link>`; the CSS already falls back to system fonts.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "The 3D library did not load" | No connection to the CDN, or a blocker stopped it |
| "Could not start WebGL" | WebGL is disabled or the graphics driver is blocked; try another browser |
| Low frame rate | Lower Cube density, or reduce the `DPR` cap in `main.js` |
| Face hard to recognise | Use a front-lit photo with the face filling most of the frame; raise Cube density; lower Relief depth |
| Part of the person is missing | Without a depth map, dark clothes on a dark backdrop can be mistaken for background. Untick Remove background, or make a depth map with the script |
| Photo cropped badly | The crop is 4:5 and biased slightly toward the top. Pre-crop the image, or adjust the `0.35` factor in `coverCrop()` |

## Browser support

Current Chrome, Edge, Firefox and Safari, desktop and mobile. WebGL 2 is used when available; WebGL 1 works if it supports standard derivatives.

## Credits

Built on [three.js](https://threejs.org) (MIT licence). The cube look was matched to reference footage supplied by the project owner; all shaders and code here are original.
