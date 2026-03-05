import { checkbox, confirm, input as promptInput, select } from "@inquirer/prompts"
import { listWhatsAppGroups, setupWhatsAppSession } from "./whatsapp.js"

export async function runFirstSetup({ config, saveConfig, sessionDir, qrPath }) {
  console.log("First run setup started.")
  console.log("If you are not already linked, scan the QR code from WhatsApp on your phone.")

  await setupWhatsAppSession({
    sessionDir,
    qrFilePath: qrPath,
  })

  const groups = await listWhatsAppGroups({ sessionDir })
  if (groups.length === 0) {
    console.log("No groups found on this WhatsApp account. You can re-run setup later.")
    return config
  }

  const filteredGroups = await filterGroupsInteractively(groups)
  if (filteredGroups.length === 0) {
    console.log("No groups matched your search.")
    return config
  }

  const selectedIds = await checkbox({
    message: "Select groups to watch on the command center screen:",
    choices: filteredGroups.map((group) => ({
      name: `${group.name} (${group.id})`,
      value: group.id,
      checked: config.watchedGroups.some((item) => item.id === group.id),
    })),
  })

  const watchedGroups = filteredGroups.filter((group) => selectedIds.includes(group.id))

  const openDashboardOnStart = await confirm({
    message: "Open dashboard automatically each time the app starts?",
    default: config.openDashboardOnStart !== false,
  })

  const next = {
    ...config,
    knownGroups: groups,
    watchedGroups,
    openDashboardOnStart,
  }

  await saveConfig(next)
  console.log(`Saved ${watchedGroups.length} watched group(s).`)
  return next
}

async function filterGroupsInteractively(groups) {
  const useSearch = await select({
    message: `Found ${groups.length} groups. Filter before selecting?`,
    choices: [
      { name: "Yes, search by name", value: true },
      { name: "No, show all groups", value: false },
    ],
  })

  if (!useSearch) return groups

  while (true) {
    const term = (
      await promptInput({
        message: "Enter search text (group name contains):",
        default: "",
      })
    ).trim()

    const current = filterGroupsByTerm(groups, term)
    console.log(`Matched ${current.length} group(s).`)

    if (current.length === 0) {
      const tryAgain = await select({
        message: "No matches. Try another search?",
        choices: [
          { name: "Yes", value: true },
          { name: "No", value: false },
        ],
      })
      if (!tryAgain) return []
      continue
    }

    const next = await select({
      message: "Use this filtered list?",
      choices: [
        { name: "Yes", value: "use" },
        { name: "Refine search", value: "refine" },
        { name: "Clear filter (show all)", value: "all" },
      ],
    })

    if (next === "use") return current
    if (next === "all") return groups
  }
}

function filterGroupsByTerm(groups, term) {
  const normalized = term.toLowerCase()
  if (!normalized) return groups
  return groups.filter((group) => group.name.toLowerCase().includes(normalized))
}
