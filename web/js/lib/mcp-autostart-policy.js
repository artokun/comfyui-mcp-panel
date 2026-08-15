export function migrateAutostartValue({ existingInstall, legacyValue }) {
  return existingInstall ? legacyValue === true : true;
}

export function panelOpenAction({ orchestratorRunning, autostartEnabled }) {
  if (orchestratorRunning) return "connect";
  return autostartEnabled ? "start" : "idle";
}
