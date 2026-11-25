export function emptyState() {
  return { sessions: [], execStdout: null, usage: null };
}

export function parseSessionLine(line) {
  const match = line.match(/^\[([^\]]+)\]\s+(\S+)\s+\|\s+(.*)$/);
  if (!match) return null;
  const name = match[1].trim();
  const endpoint = match[2];
  const fields = {};
  for (const part of match[3].split("|")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    fields[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
  }
  if (!fields.hardware) return null;
  return {
    name,
    endpoint,
    hardware: fields.hardware,
    variant: fields.variant || null,
    status: fields.status || null,
    shape: fields.shape || null,
    lastExecution: null,
  };
}

export function parseSessionList(text) {
  const sessions = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseSessionLine(line);
    if (parsed) {
      sessions.push(parsed);
      continue;
    }
    const lastExec = line.match(/^Last Execution:\s*(.+)$/i);
    if (lastExec && sessions.length > 0) {
      sessions[sessions.length - 1].lastExecution = lastExec[1].trim();
    }
  }
  return sessions;
}

export function parseUsageOutput(text) {
  const raw = String(text || "");
  const balanceMatch = raw.match(/Current balance:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const rateMatch = raw.match(/Usage rate:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const activeMatch = raw.match(/Active assignments:\s*([0-9]+)/i);
  if (!balanceMatch && !rateMatch && !activeMatch) return null;
  return {
    balance: balanceMatch ? Number(balanceMatch[1]) : null,
    ratePerHour: rateMatch ? Number(rateMatch[1]) : null,
    activeAssignments: activeMatch ? Number(activeMatch[1]) : null,
  };
}

export function parseCommandOutput(command, stdout) {
  if (command === "sessions" || command === "status" || command === "new") {
    return { sessions: parseSessionList(stdout), execStdout: null, usage: null };
  }
  if (command === "exec" || command === "run" || command === "ssh") {
    return { sessions: [], execStdout: stdout, usage: null };
  }
  if (command === "usage") {
    return { sessions: [], execStdout: null, usage: parseUsageOutput(stdout) };
  }
  return emptyState();
}
