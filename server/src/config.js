// All configuration comes from the environment (process.env), never from code. One place reads
// it, validates it and fills defaults — the rest of the server gets a frozen, typed object.
//
//   npm run dev -w server            reads server/.env if present (--env-file-if-exists)
//   PORT=9000 npm start              any variable can also be set the usual way

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", ".."); // import.meta.dirname: ESM's __dirname

const SPEC = {
  PORT: { type: "port", default: 8787 },
  HOST: { type: "string", default: "127.0.0.1" },
  LOG_DIR: { type: "path", default: "server/logs" },
  STATIC_DIR: { type: "path", default: "client/dist" },
  MAX_ROOMS: { type: "int", default: 50, min: 1, max: 10_000 },
  MAX_PLAYERS_PER_ROOM: { type: "int", default: 8, min: 1, max: 64 },
  MAX_CONNECTIONS: { type: "int", default: 500, min: 1, max: 100_000 },
  MAX_PAYLOAD_BYTES: { type: "int", default: 4096, min: 256, max: 1_048_576 },
  JOIN_TIMEOUT_MS: { type: "int", default: 5000, min: 50, max: 60_000 },
  HEARTBEAT_MS: { type: "int", default: 15_000, min: 50, max: 300_000 },
  RATE_LIMIT_PER_SEC: { type: "int", default: 10, min: 1, max: 1000 },
  RATE_LIMIT_BURST: { type: "int", default: 20, min: 1, max: 10_000 },
  SLOW_CLIENT_BYTES: { type: "int", default: 64 * 1024, min: 1024, max: 64 * 1024 * 1024 },
  DROP_CLIENT_BYTES: { type: "int", default: 1024 * 1024, min: 1024, max: 1024 * 1024 * 1024 },
  DEBUG_ROUTES: { type: "bool", default: false }, // /api/slow and friends: never in production
  QUIET: { type: "bool", default: false },
};

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function parse(name, spec, raw, problems) {
  if (raw === undefined || raw === "") {
    return spec.type === "path" ? resolve(ROOT, spec.default) : spec.default;
  }
  switch (spec.type) {
    case "port":
    case "int": {
      const n = Number(raw);
      const [min, max] = spec.type === "port" ? [0, 65_535] : [spec.min, spec.max];
      if (!Number.isInteger(n) || n < min || n > max) {
        problems.push(`${name}=${JSON.stringify(raw)}: expected an integer ${min}..${max}`);
        return spec.default;
      }
      return n;
    }
    case "bool":
      if (/^(1|true|yes|on)$/i.test(raw)) return true;
      if (/^(0|false|no|off)$/i.test(raw)) return false;
      problems.push(`${name}=${JSON.stringify(raw)}: expected true/false`);
      return spec.default;
    case "path":
      return resolve(ROOT, raw);
    default:
      return String(raw);
  }
}

/**
 * @param {Record<string, string|undefined>} env  usually process.env
 * @returns {Readonly<object>} camelCase keys: port, host, logDir, staticDir, maxRooms, ...
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const config = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    const key = name.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
    config[key] = parse(name, spec, env[name], problems);
  }
  if (config.dropClientBytes <= config.slowClientBytes) {
    problems.push("DROP_CLIENT_BYTES must be larger than SLOW_CLIENT_BYTES");
  }
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}
