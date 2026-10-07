// A dropped photo, ready for the model and the viewport (browser only): scaled
// to fit the model's image size, so the pixel positions it reports are the
// photo's own, and named by the SHA-256 of the file as dropped.

import { guessKind, type ImageKind } from "./kind";

/** Long side, in pixels. Every model in the picker reads this size without resizing it. */
export const PHOTO_MAX_SIDE = 1568;

export interface PreparedPhoto {
  name: string;
  /** SHA-256 of the file as dropped: the same photo dropped again is found by it. */
  sha256: string;
  mediaType: "image/jpeg";
  /** Base64 JPEG at width x height. */
  data: string;
  width: number;
  height: number;
}

export async function preparePhoto(file: { name: string; type: string; bytes: Uint8Array }): Promise<{ photo: PreparedPhoto; guess: ImageKind }> {
  const bitmap = await createImageBitmap(new Blob([file.bytes as BlobPart], { type: file.type }));
  const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the photo"))), "image/jpeg", 0.9));
  const photo: PreparedPhoto = {
    name: file.name,
    sha256: await sha256(file.bytes),
    mediaType: "image/jpeg",
    data: base64(new Uint8Array(await blob.arrayBuffer())),
    width: canvas.width,
    height: canvas.height,
  };
  return { photo, guess: guessKind(pixels.data, canvas.width, canvas.height) };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
