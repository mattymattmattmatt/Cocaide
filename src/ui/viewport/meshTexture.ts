// A mesh part's texture for three.js: made once from its image's bytes (kept by those bytes, so a scene composed
// again reuses it), drawn as soon as the image has loaded. Browser.

import * as THREE from "three";
import type { RebuildView } from "../../worker/protocol";

const made = new WeakMap<Uint8Array, THREE.Texture>();

/** The texture a mesh face names (a key of the view's `textures`), or null; `ready` is called once its image is in. */
export function meshTexture(v: RebuildView, key: string, ready: () => void): THREE.Texture | null {
  const im = v.textures?.[key];
  if (!im || !im.bytes.length) return null;
  const have = made.get(im.bytes);
  if (have) return have;
  const tex = new THREE.Texture();
  // glTF's texture coordinates start at the image's top-left.
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  made.set(im.bytes, tex);
  const url = URL.createObjectURL(new Blob([im.bytes as BlobPart], { type: im.mime }));
  const img = new Image();
  img.onload = () => {
    tex.image = img;
    tex.needsUpdate = true;
    URL.revokeObjectURL(url);
    ready();
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
  return tex;
}
