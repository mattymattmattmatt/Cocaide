// The Export STEP button in an Export body feature's properties runs this:
// the app registers what writes the file (it has the kernel and the download),
// so the feature's panel stays a plain declared form.

let handler: ((featureId: string) => void) | null = null;

export function setExportBodyHandler(h: ((featureId: string) => void) | null): void {
  handler = h;
}

export function runExportBody(featureId: string): boolean {
  if (!handler) return false;
  handler(featureId);
  return true;
}
