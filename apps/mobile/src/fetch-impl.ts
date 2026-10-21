// Web and Electron: the browser fetch already streams response bodies.
export const platformFetch: typeof fetch | undefined = undefined
