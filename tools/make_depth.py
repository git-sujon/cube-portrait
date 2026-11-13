#!/usr/bin/env python3
"""
make_depth.py - build a depth map and cut-out mask for a portrait photo.

The Cube Assembly Portrait page can guess depth from any photo, but a guess
is all it is. This script measures the face instead: it fits a 468-point 3D
face mesh to the photo, cuts the person out of the background, and writes

  <name>_photo.jpg   the photo cropped to 4:5 (what the cubes are coloured from)
  <name>_depth.png   R,G,B = height (white = nearest the viewer), A = person mask

Load the photo with "Use your photo" and the depth PNG with "Add depth map"
in the Tune panel. With --js it also writes default-portrait.js so the pair
becomes the page's built-in portrait.

Requires:  pip install "mediapipe==0.10.14" scipy pillow numpy
Usage:     python make_depth.py me.png [--out-dir .] [--js]
"""
import argparse, base64, io, os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import ConvexHull
import mediapipe as mp

PHOTO_W, PHOTO_H = 720, 900       # 4:5
DEPTH_W, DEPTH_H = 360, 450


def crop_4x5(im):
    """Same crop the page uses: centred horizontally, biased toward the top."""
    w, h = im.size
    if w / h > 4 / 5:
        ch, cw = h, h * 4 / 5
    else:
        cw, ch = w, w * 5 / 4
    x0, y0 = (w - cw) / 2, (h - ch) * 0.35
    return im.crop((round(x0), round(y0), round(x0 + cw), round(y0 + ch)))


def person_mask(rgb):
    """Person cut-out: ML segmentation, plus anything clearly brighter than the backdrop."""
    with mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0) as seg:
        prob = seg.process(rgb).segmentation_mask
    mask = prob > 0.5
    # a dark jacket on a dark backdrop can confuse the model; pixels that differ
    # from the backdrop colour (sampled from the top corners) are kept too
    h, w = mask.shape
    corners = np.concatenate([rgb[:h // 12, :w // 12].reshape(-1, 3), rgb[:h // 12, -w // 12:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    diff = np.abs(rgb.astype(np.float32) - bg).max(axis=2)
    if np.std(corners) < 12:                     # only trust this on a plain backdrop
        mask |= diff > 9
    mask = ndimage.binary_opening(mask, iterations=2)
    mask = ndimage.binary_closing(mask, iterations=6)
    mask = ndimage.binary_fill_holes(mask)
    # morphology nibbles at the frame; let the body run right to the edges again
    e = 10
    mask[-e:, :] = mask[-e - 1, :]
    mask[:, :e] = mask[:, e:e + 1]
    mask[:, -e:] = mask[:, -e - 1:-e]
    # keep only the largest connected shape
    lab, n = ndimage.label(mask)
    if n > 1:
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        mask = lab == (1 + int(np.argmax(sizes)))
    return mask


def face_mesh(rgb):
    with mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1, refine_landmarks=False) as fm:
        res = fm.process(rgb)
    if not res.multi_face_landmarks:
        return None
    h, w = rgb.shape[:2]
    lm = res.multi_face_landmarks[0].landmark
    # z is in the same scale as x (image widths); negative = toward the camera
    return np.array([[p.x * w, p.y * h, -p.z * w] for p in lm], dtype=np.float32)


def build_depth(rgb):
    h, w = rgb.shape[:2]
    mask = person_mask(rgb)
    # pad by repeating the edges, so the frame of the photo is not mistaken for the
    # edge of the body (shoulders run off the bottom and sides)
    pad = max(h, w) // 2
    dist = ndimage.distance_transform_edt(np.pad(mask, pad, mode="edge"))[pad:-pad, pad:-pad]

    pts = face_mesh(rgb)
    if pts is None:
        print("No face found; using the inflated silhouette only.", file=sys.stderr)
        head_w = w * 0.4
    else:
        head_w = pts[:, 0].max() - pts[:, 0].min()

    # 1) inflate the silhouette into a rounded bust: a dome that reaches full height
    #    about half a head-width in from the edge
    R = head_w * 0.55
    u = np.clip(dist / R, 0, 1)
    dome = np.sqrt(u * (2 - u)) * R * 0.85          # in pixels of depth
    depth = dome.copy()

    if pts is not None:
        # 2) real face geometry inside the face outline
        hull = ConvexHull(pts[:, :2])
        interp = LinearNDInterpolator(pts[:, :2], pts[:, 2])
        yy, xx = np.mgrid[0:h, 0:w]
        fz = interp(xx, yy)
        inside = ~np.isnan(fz)
        fz = np.nan_to_num(fz)
        # feather the join so the face melts into the head shape
        feather = ndimage.distance_transform_edt(inside)
        wgt = np.clip(feather / (head_w * 0.16), 0, 1)
        wgt = wgt * wgt * (3 - 2 * wgt)
        ring = inside & (feather < head_w * 0.05)
        offset = np.median(dome[ring]) - np.median(fz[ring]) + head_w * 0.06
        depth = dome * (1 - wgt) + (fz + offset) * wgt

        # 3) the torso sits behind the face: ease everything below the chin back a little
        chin_y = pts[:, 1].max()
        below = np.clip((yy - chin_y) / (head_w * 0.5), 0, 1)
        depth -= below * head_w * 0.16 * (1 - wgt)

    # 4) a touch of photo detail (hair strands, collar, folds)
    luma = (rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)) / 255
    detail = luma - ndimage.gaussian_filter(luma, head_w * 0.03)
    depth += detail * head_w * 0.05

    depth = ndimage.gaussian_filter(depth, max(1.0, head_w * 0.006))
    depth[~mask] = 0
    lo, hi = depth[mask].min(), depth[mask].max()
    norm = np.clip((depth - lo) / (hi - lo), 0, 1)
    norm[~mask] = 0
    relief = (hi - lo) / h                         # true depth as a fraction of image height
    return norm, mask, relief


def data_uri(img, fmt, **kw):
    buf = io.BytesIO(); img.save(buf, fmt, **kw)
    mime = "image/jpeg" if fmt == "JPEG" else "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(buf.getvalue()).decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--js", action="store_true", help="also write default-portrait.js")
    a = ap.parse_args()

    photo = crop_4x5(Image.open(a.image).convert("RGB")).resize((PHOTO_W, PHOTO_H), Image.LANCZOS)
    norm, mask, relief = build_depth(np.array(photo))

    d8 = Image.fromarray((norm * 255).astype(np.uint8)).resize((DEPTH_W, DEPTH_H), Image.LANCZOS)
    m8 = Image.fromarray((mask * 255).astype(np.uint8)).resize((DEPTH_W, DEPTH_H), Image.LANCZOS)
    depth_img = Image.merge("RGBA", (d8, d8, d8, m8))

    name = os.path.splitext(os.path.basename(a.image))[0]
    os.makedirs(a.out_dir, exist_ok=True)
    photo.save(os.path.join(a.out_dir, name + "_photo.jpg"), quality=88)
    depth_img.save(os.path.join(a.out_dir, name + "_depth.png"))
    print("relief depth (fraction of image height): %.3f  ->  slider value %.2f" % (relief, relief * 10))

    if a.js:
        js = ("// Built-in portrait for Cube Assembly Portrait. Generated by tools/make_depth.py\n"
              "window.DEFAULT_PORTRAIT = {\n  relief: %.3f,\n  photo: \"%s\",\n  depth: \"%s\"\n};\n"
              % (relief * 10, data_uri(photo, "JPEG", quality=82), data_uri(depth_img, "PNG", optimize=True)))
        open(os.path.join(a.out_dir, "default-portrait.js"), "w").write(js)


if __name__ == "__main__":
    main()
