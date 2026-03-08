#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, "..")
const entry = path.join(appRoot, "src", "index.js")
const logFile = path.join(appRoot, "whatsapp-command-center.log")
const configPath = path.join(appRoot, "data", "config.json")

const args = process.argv.slice(2)
const forceForeground = args.includes("--foreground")
const forceSetup = args.includes("--setup")
const forceRescan = args.includes("--rescan")

function needsSetup() {
  if (forceSetup) return true
  try {
    const raw = fs.readFileSync(configPath, "utf8")
    const config = JSON.parse(raw)
    return !Array.isArray(config.watchedGroups) || config.watchedGroups.length === 0
  } catch {
    return true
  }
}

const foreground = forceForeground || needsSetup() || forceRescan

if (foreground) {
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: "inherit",
    cwd: appRoot,
    env: process.env,
  })

  child.on("exit", (code) => {
    process.exit(code ?? 0)
  })
} else {
  const fd = fs.openSync(logFile, "a")
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: appRoot,
    env: process.env,
  })

  child.unref()
  console.log(`whatsappCC running in background (pid ${child.pid})`)
  console.log(`Logs: ${logFile}`)
}
