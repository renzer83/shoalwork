import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron"
import { APP_URL_ARG, resolveAppUrl } from "./app-config.js"
import { APP_ORIGIN, APP_SCHEME, resolveAppFile } from "./app-files.js"
import { CoreOrigins } from "./core-origins.js"
import { preflightStatusLine, withCors } from "./cors.js"
import { buildCsp, inlineScriptHashes } from "./csp.js"
import { loadSavedCoreUrl, saveCoreUrl } from "./saved-core.js"

// The Expo export (apps/web/dist) is shipped as a resource when packaged and read from the workspace in development.
const distDir = (): string =>
  app.isPackaged ? path.join(process.resourcesPath, "dist") : path.resolve(__dirname, "../../../web/dist")

const appUrl = resolveAppUrl(process.env)
const coreOrigins = new CoreOrigins([appUrl])

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const plain = (status: number, text: string): Response => new Response(text, { status })

const serveApp = (): void => {
  const root = distDir()
  protocol.handle(APP_SCHEME, async (request) => {
    let urlPath: string
    try {
      urlPath = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return plain(400, "Bad request")
    }
    const file = resolveAppFile(root, urlPath)
    if (file === undefined) {
      return plain(404, "Not found")
    }
    // The origins are read per request, so a core saved in Setup applies to the next document load.
    const connectOrigins = coreOrigins.list()
    if (file.endsWith(".html")) {
      const html = await readFile(file, "utf8")
      const csp = buildCsp({ scriptHashes: inlineScriptHashes(html), connectOrigins })
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp },
      })
    }
    const upstream = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(upstream.headers)
    headers.set("content-security-policy", buildCsp({ scriptHashes: [], connectOrigins }))
    return new Response(upstream.body, { status: upstream.status, headers })
  })
}

const secureSession = (): void => {
  // Nothing needs camera, microphone or notifications yet; the voice task opts in to what it needs.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const fromApp = details.webContents?.getURL().startsWith(`${APP_ORIGIN}/`) === true
    if (!fromApp || !coreOrigins.has(details.url)) {
      callback({})
      return
    }
    const statusLine = preflightStatusLine(details.method)
    callback({
      responseHeaders: withCors(details.responseHeaders, APP_ORIGIN),
      ...(statusLine === undefined ? {} : { statusLine }),
    })
  })
}

// Setup tells the shell which core was saved; only the app's own pages may ask.
const listenForCoreUrl = (): void => {
  ipcMain.handle("shoalwork:set-core-url", (event, url: unknown) => {
    if (typeof url !== "string" || !(event.senderFrame?.url ?? "").startsWith(`${APP_ORIGIN}/`)) {
      return false
    }
    const accepted = coreOrigins.add(url)
    if (accepted) {
      saveCoreUrl(app.getPath("userData"), url)
    }
    return accepted
  })
}

const openWindow = (): void => {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [`${APP_URL_ARG}${appUrl}`],
    },
  })
  window.once("ready-to-show", () => window.show())
  // In-app navigation stays on the app origin; anything else is not ours to open.
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  void window.loadURL(`${APP_ORIGIN}/`)
}

app.whenReady().then(() => {
  const saved = loadSavedCoreUrl(app.getPath("userData"))
  if (saved !== undefined) {
    coreOrigins.add(saved)
  }
  serveApp()
  secureSession()
  listenForCoreUrl()
  openWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
