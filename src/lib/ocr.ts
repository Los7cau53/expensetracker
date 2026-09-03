/**
 * On-device OCR, used only to read a payment screenshot.
 *
 * The engine, the WASM core and the English model are served from this app's
 * own origin (`public/ocr/`) rather than the library's default CDN, so the
 * feature makes no third-party request, works offline once cached, and the
 * screenshot never leaves the device. The whole bundle is ~6 MB, which is why
 * it is imported lazily — nothing here is fetched until a screenshot is read.
 */

// Absolute, resolved against the document: these paths are handed to a web
// worker, and a relative one would resolve against the worker's own URL
// (/<repo>/ocr/worker.min.js), producing /<repo>/ocr/ocr/... under a subpath.
const BASE = new URL(`${import.meta.env.BASE_URL}ocr/`, document.baseURI).href

export interface OcrResult {
  text: string
  /** Tesseract's 0–100 confidence, for warning about a poor read. */
  confidence: number
}

let warmWorker: Awaited<ReturnType<typeof makeWorker>> | null = null

async function makeWorker(onProgress?: (fraction: number) => void) {
  const { createWorker } = await import('tesseract.js')
  return createWorker('eng', 1, {
    workerPath: `${BASE}worker.min.js`,
    // Pinned to one core rather than pointing at the directory: left to choose,
    // Tesseract probes for a variant and asks for whichever build it likes,
    // which would mean vendoring several. The embedded (.wasm.js) build is used
    // because the loader+sibling pair, though ~700 KB smaller, resolves its
    // .wasm as a bare relative name that has no base URL inside a worker.
    // Needs WASM SIMD — Safari 16.4+, Chrome 91+.
    corePath: `${BASE}tesseract-core-simd-lstm.wasm.js`,
    langPath: BASE,
    // Default caching writes the model into IndexedDB after the first fetch.
    // 'refresh' would re-download 2.9 MB on every single read.
    cacheMethod: 'write',
    logger: (m: { status: string; progress: number }) => {
      if (!onProgress) return
      // Loading the model dominates the first run; recognition dominates later
      // ones. Both are reported on one 0–1 scale.
      if (m.status === 'recognizing text') onProgress(0.5 + m.progress * 0.5)
      else onProgress(Math.min(0.5, m.progress * 0.5))
    },
  })
}

/**
 * Reads text out of an image. The first call downloads and caches the engine;
 * later calls reuse the warm worker and take about a second.
 */
export async function readImageText(
  image: Blob | File,
  onProgress?: (fraction: number) => void,
): Promise<OcrResult> {
  if (!warmWorker) warmWorker = await makeWorker(onProgress)
  const { data } = await warmWorker.recognize(image)
  onProgress?.(1)
  return { text: data.text ?? '', confidence: data.confidence ?? 0 }
}

/** Frees the worker and its WASM heap. */
export async function releaseOcr(): Promise<void> {
  if (!warmWorker) return
  const w = warmWorker
  warmWorker = null
  await w.terminate()
}
