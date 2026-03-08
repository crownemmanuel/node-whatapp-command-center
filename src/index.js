import { exec } from "node:child_process"
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import pino from "pino"
import { getMediaDir, getQrPath, getSessionDir, loadConfig, normalizeConfig, saveConfig } from "./config-store.js"
import { createDashboardServer } from "./dashboard-server.js"
import { runFirstSetup } from "./setup.js"
import { WhatsAppBridge, resetWhatsAppSession } from "./whatsapp.js"

const LOG = pino({ name: "whatsapp-command-center", level: process.env.LOG_LEVEL || "info" })

async function main() {
  let config = await loadConfig()
  const sessionDir = getSessionDir()
  const mediaDir = getMediaDir()
  const qrPath = getQrPath()
  const forceRescan = process.argv.includes("--rescan")
  const forceSetup = process.argv.includes("--setup") || forceRescan

  if (forceRescan) {
    console.log("Rescan requested: clearing WhatsApp session so you can scan the QR code again...")
    await resetWhatsAppSession(sessionDir)
  }

  if (forceSetup || !config.watchedGroups.length) {
    if (forceSetup) {
      console.log(forceRescan ? "Scan the new QR code, then choose groups again." : "Setup mode enabled. Reconfiguring watched groups...")
    }
    config = await runFirstSetup({
      config,
      saveConfig,
      sessionDir,
      qrPath,
    })

    if (!config.watchedGroups.length) {
      console.log("No watched groups configured. Exiting.")
      process.exit(0)
    }
  }

  const state = {
    connected: false,
    knownGroups: mergeGroups(config.knownGroups, config.watchedGroups),
    watchedGroups: config.watchedGroups,
    keywordMode: config.keywordMode,
    keywords: config.keywords,
    pulseEnabled: config.pulseEnabled,
    pulseMode: config.pulseMode,
    pulseKeywords: config.pulseKeywords,
    flashMode: config.pulseMode,
    groupKeywords: config.groupKeywords,
    hasGroupPin: Boolean(config.groupPinHash),
    messageFontSize: config.messageFontSize,
    showImages: config.showImages,
    messages: [],
  }

  let watchedById = new Map(state.watchedGroups.map((group) => [group.id, group.name]))

  const dashboard = createDashboardServer({
    port: config.dashboardPort,
    mediaDir,
    getState: () => ({ ...state }),
    onUnlockGroups: async (incoming) => {
      const pin = typeof incoming?.pin === "string" ? incoming.pin.trim() : ""
      if (config.groupPinHash && !verifyPin(pin, config.groupPinHash)) {
        const error = new Error("Invalid PIN")
        error.statusCode = 403
        throw error
      }

      return {
        knownGroups: mergeGroups(config.knownGroups, config.watchedGroups),
        watchedGroups: config.watchedGroups,
        groupKeywords: config.groupKeywords,
      }
    },
    onUpdateSettings: async (incoming) => {
      const pinNewRaw = typeof incoming.groupPinNew === "string" ? incoming.groupPinNew.trim() : ""
      const wantsPinChange = pinNewRaw.length > 0
      const pinCurrent = typeof incoming.groupPinCurrent === "string" ? incoming.groupPinCurrent.trim() : ""
      const pinAuth = typeof incoming.groupPinAuth === "string" ? incoming.groupPinAuth.trim() : ""
      const isGroupsUpdate = Array.isArray(incoming.watchedGroups) || isObject(incoming.groupKeywords)

      if (config.groupPinHash && wantsPinChange && !verifyPin(pinCurrent, config.groupPinHash)) {
        throw badRequest("Current PIN is incorrect")
      }
      if (wantsPinChange && pinNewRaw && !/^\d{4,8}$/.test(pinNewRaw)) {
        throw badRequest("PIN must be 4-8 digits")
      }
      if (config.groupPinHash && isGroupsUpdate && !verifyPin(pinAuth, config.groupPinHash)) {
        throw forbidden("PIN required to update groups")
      }

      const next = normalizeConfig({
        ...config,
        knownGroups: mergeGroups(config.knownGroups, incoming.knownGroups, incoming.watchedGroups),
        keywordMode: incoming.keywordMode,
        keywords: incoming.keywords,
        pulseEnabled: incoming.pulseEnabled,
        pulseMode: incoming.pulseMode,
        pulseKeywords: incoming.pulseKeywords,
        flashMode: incoming.pulseMode === "keywords" ? "keywords" : "all",
        groupKeywords: incoming.groupKeywords,
        messageFontSize: incoming.messageFontSize,
        showImages: incoming.showImages,
        groupPinHash: wantsPinChange
          ? (pinNewRaw ? hashPin(pinNewRaw) : "")
          : config.groupPinHash,
        watchedGroups: Array.isArray(incoming.watchedGroups)
          ? incoming.watchedGroups
          : config.watchedGroups,
      })

      config = await saveConfig(next)
      state.knownGroups = mergeGroups(config.knownGroups, config.watchedGroups)
      state.keywordMode = config.keywordMode
      state.keywords = config.keywords
      state.pulseEnabled = config.pulseEnabled
      state.pulseMode = config.pulseMode
      state.pulseKeywords = config.pulseKeywords
      state.flashMode = config.pulseMode
      state.groupKeywords = config.groupKeywords
      state.hasGroupPin = Boolean(config.groupPinHash)
      state.messageFontSize = config.messageFontSize
      state.showImages = config.showImages
      state.watchedGroups = config.watchedGroups
      watchedById = new Map(config.watchedGroups.map((group) => [group.id, group.name]))
      if (state.keywordMode === "keywords") {
        state.messages = state.messages.filter((message) =>
          messageMatchesFilter(message, state)
        )
      }
      return { ...state }
    },
  })

  if (config.openDashboardOnStart) {
    openInBrowser(`http://localhost:${config.dashboardPort}`)
  }

  const bridge = new WhatsAppBridge({
    sessionDir,
    mediaDir,
    onConnectionChange: (connected) => {
      state.connected = connected
      dashboard.broadcast({ type: "state", payload: { ...state } })
    },
    onMessage: (incoming) => {
      if (!watchedById.has(incoming.chatId)) return

      const message = {
        ...incoming,
        groupName: watchedById.get(incoming.chatId),
      }

      state.knownGroups = mergeGroups(state.knownGroups, [{ id: incoming.chatId, name: message.groupName }])

      if (!messageMatchesFilter(message, state)) {
        return
      }

      state.messages = [...state.messages, message].slice(-500)
      dashboard.broadcast({
        type: "new-message",
        payload: {
          message,
          flash: shouldFlashMessage(message, state),
        },
      })
    },
  })

  await bridge.start()
  await bridge.waitUntilReady()

  console.log("WhatsApp Command Center is running.")
  console.log(`Dashboard: http://localhost:${config.dashboardPort}`)

  const shutdown = async (signal) => {
    LOG.info({ signal }, "Shutting down")
    await bridge.stop()
    dashboard.close()
    process.exit(0)
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT")
  })
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
  })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  LOG.error({ err: error }, "Startup failed")
  console.error(`Startup failed: ${message}`)
  process.exit(1)
})

function openInBrowser(url) {
  if (process.env.WACC_OPEN_DASHBOARD === "0") return

  const cmd = process.platform === "darwin"
    ? `open "${url}"`
    : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`

  exec(cmd, (error) => {
    if (error) {
      LOG.warn({ err: error }, "Could not auto-open dashboard")
    }
  })
}

function messageMatchesFilter(message, keywordMode, keywords) {
  if (keywordMode?.keywordMode) {
    const enabled = keywordMode.keywordMode === "keywords"
    const list = getKeywordsForMessage(message, keywordMode)
    return matchesKeywords(message, list, enabled)
  }
  return matchesKeywords(message, keywords, keywordMode === "keywords")
}

function shouldFlashMessage(message, state) {
  if (!state.pulseEnabled) return false
  if (state.pulseMode !== "keywords") return true
  const list = Array.isArray(state.pulseKeywords) ? state.pulseKeywords : []
  if (list.length === 0) return false
  return matchesKeywords(message, list, true)
}

function getKeywordsForMessage(message, state) {
  const groupId = String(message?.chatId || "")
  const groupSpecific = state?.groupKeywords?.[groupId]
  if (Array.isArray(groupSpecific) && groupSpecific.length > 0) return groupSpecific
  return Array.isArray(state?.keywords) ? state.keywords : []
}

function matchesKeywords(message, keywords, enabled) {
  if (!enabled) return true
  const list = Array.isArray(keywords) ? keywords : []
  if (list.length === 0) return true
  const text = String(message?.text || "").toLowerCase()
  return list.some((keyword) => text.includes(String(keyword).toLowerCase()))
}

function mergeGroups(...lists) {
  const byId = new Map()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const group of list) {
      if (!group || typeof group !== "object") continue
      const id = String(group.id || "").trim()
      if (!id) continue
      const name = String(group.name || "").trim()
      const current = byId.get(id)
      if (!current) {
        byId.set(id, { id, name: name || id })
      } else if (name && (current.name === current.id || !current.name)) {
        byId.set(id, { id, name })
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hashPin(pin) {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(pin, salt, 32).toString("hex")
  return `${salt}:${hash}`
}

function verifyPin(pin, storedHash) {
  if (!pin || !storedHash || !storedHash.includes(":")) return false
  const [salt, expectedHex] = storedHash.split(":")
  if (!salt || !expectedHex) return false
  const actualHex = scryptSync(pin, salt, 32).toString("hex")
  const expected = Buffer.from(expectedHex, "hex")
  const actual = Buffer.from(actualHex, "hex")
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function forbidden(message) {
  const error = new Error(message)
  error.statusCode = 403
  return error
}
