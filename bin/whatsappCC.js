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

const args = process.argv.slice(2)
const foreground = args.includes("--foreground")

if (foreground) {
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    cwd: appRoot,
    env: process.env,
  })

  child.on("exit", (code) => {
    process.exit(code ?? 0)
  })
} else {
  const fd = fs.openSync(logFile, "a")
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: appRoot,
    env: process.env,
  })

  child.unref()
  console.log(`whatsappCC running in background (pid ${child.pid})`)
  console.log(`Logs: ${logFile}`)
}
