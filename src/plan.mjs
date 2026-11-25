export const GPUS = ["T4", "L4", "G4", "H100", "A100"];
export const TPUS = ["v5e1", "v6e1"];

function requireName(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function appendHardware(argv, action) {
  const gpu = action.gpu || null;
  const tpu = action.tpu || null;
  if (gpu && tpu) {
    throw new Error("choose a GPU or a TPU, not both");
  }
  if (gpu) {
    if (!GPUS.includes(gpu)) throw new Error(`unsupported gpu: ${gpu}`);
    argv.push("--gpu", gpu);
  }
  if (tpu) {
    if (!TPUS.includes(tpu)) throw new Error(`unsupported tpu: ${tpu}`);
    argv.push("--tpu", tpu);
  }
  if (action.highMem) argv.push("--high-mem");
}

function sessionFlag(action) {
  return ["-s", requireName(action.session, "session name")];
}

function appendExecOptions(argv, action) {
  if (action.timeout !== undefined && action.timeout !== null && String(action.timeout).trim() !== "") {
    const num = Number(action.timeout);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error("timeout must be a non-negative number");
    }
    argv.push("--timeout", String(num));
  }
  if (Array.isArray(action.env)) {
    for (const pair of action.env) {
      const value = requireName(pair, "env variable").trim();
      if (!value.includes("=")) {
        throw new Error(`invalid env variable (expected KEY=VALUE): ${value}`);
      }
      argv.push("--env", value);
    }
  }
}

export function plan(action) {
  if (!action || typeof action.type !== "string") {
    throw new Error("action type is required");
  }

  switch (action.type) {
    case "new": {
      const argv = ["new", "-s", requireName(action.name, "session name")];
      appendHardware(argv, action);
      return { argv, stdin: null };
    }
    case "sessions":
      return { argv: ["sessions"], stdin: null };
    case "status":
      return {
        argv: action.session ? ["status", ...sessionFlag(action)] : ["status"],
        stdin: null,
      };
    case "restart-kernel":
      return { argv: ["restart-kernel", ...sessionFlag(action)], stdin: null };
    case "stop":
      return { argv: ["stop", ...sessionFlag(action)], stdin: null };
    case "url":
      return { argv: ["url", ...sessionFlag(action)], stdin: null };
    case "exec": {
      const argv = ["exec", ...sessionFlag(action)];
      appendExecOptions(argv, action);
      if (action.outputImage) {
        argv.push("--output-image", requireName(action.outputImage, "output image path"));
      }
      if (action.file) {
        argv.push("-f", requireName(action.file, "file"));
        return { argv, stdin: null };
      }
      if (typeof action.code !== "string" || action.code.length === 0) {
        throw new Error("exec needs code or a file");
      }
      return { argv, stdin: action.code };
    }
    case "ssh": {
      const argv = ["ssh", ...sessionFlag(action), "--"];
      if (Array.isArray(action.args) && action.args.length > 0) {
        for (const item of action.args) argv.push(requireName(item, "ssh argument"));
      } else {
        argv.push(requireName(action.command, "shell command"));
      }
      return { argv, stdin: null };
    }
    case "run": {
      // A fresh VM. Never `-s`: colab run stores that name and then tears the VM down.
      const argv = ["run"];
      appendHardware(argv, action);
      if (action.keep) argv.push("--keep");
      appendExecOptions(argv, action);
      argv.push(requireName(action.script, "script path"));
      if (Array.isArray(action.args) && action.args.length > 0) {
        for (const item of action.args) argv.push(requireName(item, "script argument"));
      }
      return { argv, stdin: null };
    }
    case "ls": {
      const argv = ["ls", ...sessionFlag(action)];
      if (action.path) argv.push(action.path);
      return { argv, stdin: null };
    }
    case "upload":
      return {
        argv: [
          "upload",
          ...sessionFlag(action),
          requireName(action.local, "local path"),
          requireName(action.remote, "remote path"),
        ],
        stdin: null,
      };
    case "download":
      return {
        argv: [
          "download",
          ...sessionFlag(action),
          requireName(action.remote, "remote path"),
          requireName(action.local, "local path"),
        ],
        stdin: null,
      };
    case "rm":
      return {
        argv: ["rm", ...sessionFlag(action), requireName(action.path, "path")],
        stdin: null,
      };
    case "install": {
      const argv = ["install", ...sessionFlag(action)];
      if (action.requirements) {
        argv.push("-r", requireName(action.requirements, "requirements file"));
      } else if (Array.isArray(action.packages) && action.packages.length > 0) {
        for (const pkg of action.packages) argv.push(requireName(pkg, "package"));
      } else {
        throw new Error("install needs packages or a requirements file");
      }
      return { argv, stdin: null };
    }
    case "drivemount": {
      const argv = ["drivemount", ...sessionFlag(action)];
      if (action.path) argv.push(action.path);
      return { argv, stdin: null };
    }
    case "log": {
      const argv = ["log", ...sessionFlag(action)];
      if (action.lines) argv.push("-n", String(action.lines));
      if (action.eventType) argv.push("-t", requireName(action.eventType, "event type"));
      if (action.output) argv.push("-o", requireName(action.output, "output path"));
      return { argv, stdin: null };
    }
    case "usage":
      return { argv: ["usage"], stdin: null };
    case "auth":
      return { argv: ["auth", ...sessionFlag(action)], stdin: null };
    case "version":
      return { argv: ["version"], stdin: null };
    case "whoami":
      return { argv: ["whoami"], stdin: null };
    default:
      throw new Error(`unknown action: ${action.type}`);
  }
}
