// Heartbeat (Lab 4, extracted in Lab 7 so it can be tested with fake timers). Every interval each
// client gets a ping; a client that missed two pongs in a row is terminated (dead NAT mapping,
// sleeping laptop). The socket layer resets `missedPongs` to 0 whenever a pong arrives.

export type HeartbeatClient = {
  missedPongs: number;
  ping(): void;
  terminate(): void;
};

/** One round: terminate the silent, ping the rest. Returns how many were terminated. */
export function heartbeatRound(clients: Iterable<HeartbeatClient>, maxMissed = 2): number {
  let terminated = 0;
  for (const client of clients) {
    if (client.missedPongs >= maxMissed) {
      client.terminate(); // no close handshake: the peer is not listening anyway
      terminated++;
      continue;
    }
    client.missedPongs++;
    client.ping();
  }
  return terminated;
}

/** Runs heartbeatRound every `intervalMs`. Returns a stop function. Does not keep Node alive. */
export function startHeartbeat(
  intervalMs: number,
  clients: () => Iterable<HeartbeatClient>,
  onTerminated: (count: number) => void = () => {},
): () => void {
  const timer = setInterval(() => {
    const n = heartbeatRound(clients());
    if (n) onTerminated(n);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
