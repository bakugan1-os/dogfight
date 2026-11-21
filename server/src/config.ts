// All configuration comes from the environment (process.env), never from code. One place reads
// it, validates it and fills defaults — the rest of the server gets a frozen, typed object.
//
//   npm run dev -w server            reads server/.env if present
//   PORT=9000 npm start              any variable can also be set the usual way
//
// Lab 6: the hand-written spec table became a zod schema. The TYPE of the config is inferred
// from the schema, and the env names (MAX_ROOMS) are turned into property names (maxRooms) by a
// template-literal type — so `config.maxRoom` (typo) is a compile error, not `undefined`.

import { resolve } from "node:path";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..", ".."); // import.meta.dirname: ESM's __dirname

/** An empty variable (`PORT=`) means "not set": use the default, like before. */
const blank = (v: unknown) => (v === "" ? undefined : v);
const int = (def: number, min: number, max: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def));
const bool = (def: boolean) => z.preprocess(blank, z.stringbool().default(def));
const path = (def: string) =>
  z.preprocess(blank, z.string().default(def)).transform((p) => resolve(ROOT, p));

export const EnvSchema = z
  .object({
    PORT: int(8787, 0, 65_535),
    HOST: z.preprocess(blank, z.string().default("127.0.0.1")),
    LOG_DIR: path("server/logs"),
    STATIC_DIR: path("client/dist"),
    MAX_ROOMS: int(50, 1, 10_000),
    MAX_PLAYERS_PER_ROOM: int(8, 1, 255), // 255: player slots are one byte on the wire
    MAX_CONNECTIONS: int(500, 1, 100_000),
    MAX_PAYLOAD_BYTES: int(4096, 256, 1_048_576),
    JOIN_TIMEOUT_MS: int(5000, 50, 60_000),
    HEARTBEAT_MS: int(15_000, 50, 300_000),
    RATE_LIMIT_PER_SEC: int(10, 1, 1000),
    RATE_LIMIT_BURST: int(20, 1, 10_000),
    SLOW_CLIENT_BYTES: int(64 * 1024, 1024, 64 * 1024 * 1024),
    DROP_CLIENT_BYTES: int(1024 * 1024, 1024, 1024 * 1024 * 1024),
    DEBUG_ROUTES: bool(false), // /api/slow and friends: never in production
    NETSIM: bool(false), // Lab 5 latency injector (?lag=&jitter=&drop=)
    INPUT_RATE_PER_SEC: int(45, 1, 1000), // real-time inputs (30/s)
    INPUT_RATE_BURST: int(60, 1, 10_000),
    QUIET: bool(false),
    // ---- Lab 8: production -------------------------------------------------------------------
    LOG_LEVEL: z.preprocess(
      blank,
      z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    ),
    /** Which build is running: set at `docker build` (--build-arg GIT_SHA=…); shown in /health. */
    GIT_SHA: z.preprocess(blank, z.string().max(64).default("dev")),
    /**
     * Pages allowed to open a WebSocket, comma-separated ("https://dogfight.fly.dev,…").
     * Empty = only the page served by this server itself (Origin host == Host header). "*" = any.
     */
    ALLOWED_ORIGINS: z
      .preprocess(blank, z.string().default(""))
      .transform((s) =>
        s
          .split(",")
          .map((o) => o.trim().replace(/\/$/, ""))
          .filter(Boolean),
      )
      .pipe(z.array(z.union([z.literal("*"), z.url({ protocol: /^https?$/ })]))),
    MAX_CONNECTIONS_PER_IP: int(20, 1, 100_000),
    /** New WebSocket handshakes per second from one address (a reconnect storm, a flood script). */
    CONNECT_RATE_PER_IP: int(5, 1, 10_000),
    CONNECT_BURST_PER_IP: int(20, 1, 10_000),
    /** Behind a proxy (Fly, Render) the socket's address is the PROXY: trust X-Forwarded-For. */
    TRUST_PROXY: bool(false),
    /** SIGTERM: how long WebSocket clients get to close before they are cut. */
    SHUTDOWN_GRACE_MS: int(3000, 0, 8000),
  })
  .refine((c) => c.DROP_CLIENT_BYTES > c.SLOW_CLIENT_BYTES, {
    message: "DROP_CLIENT_BYTES must be larger than SLOW_CLIENT_BYTES",
    path: ["DROP_CLIENT_BYTES"],
  });

/** "MAX_PLAYERS_PER_ROOM" -> "maxPlayersPerRoom", computed by the TYPE checker. */
export type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Lowercase<Head>}${Capitalize<CamelCase<Tail>>}`
  : Lowercase<S>;

type Env = z.output<typeof EnvSchema>;
export type ServerConfig = Readonly<{ [K in keyof Env & string as CamelCase<K>]: Env[K] }>;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const camel = (name: string) =>
  name.toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** @param env usually process.env */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const name = String(issue.path[0] ?? "config");
        const raw = env[name];
        return raw === undefined
          ? issue.message
          : `${name}=${JSON.stringify(raw)}: ${issue.message}`;
      }),
    );
  }
  const config = Object.fromEntries(Object.entries(result.data).map(([k, v]) => [camel(k), v]));
  // CAST — the only `as T` in the codebase: Object.fromEntries returns Record<string, …>; the TYPE of the
  // renamed keys is computed by CamelCase above, the runtime renaming by camel() — a test
  // (config: every key is camelCase) checks that the two agree.
  return Object.freeze(config) as ServerConfig;
}
