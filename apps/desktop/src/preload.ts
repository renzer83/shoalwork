import { contextBridge, ipcRenderer } from "electron"

const APP_URL_ARG = "--shoalwork-app-url="

// The window loads only the bundled app; the bridge carries the shell's APP_URL and one call to tell the shell
// which core the user saved in Setup (the shell then allows it in the CSP and CORS).
const appUrl = process.argv.find((arg) => arg.startsWith(APP_URL_ARG))?.slice(APP_URL_ARG.length)

contextBridge.exposeInMainWorld("shoalwork", {
  platform: "desktop",
  appUrl: appUrl ?? null,
  setCoreUrl: (url: string): Promise<boolean> => ipcRenderer.invoke("shoalwork:set-core-url", url),
})
