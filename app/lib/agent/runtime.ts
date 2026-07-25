import "server-only";

import {FullAdapter} from "../chain/adapter";
import {MockAdapter} from "../chain/mockAdapter";
import {RealAdapter} from "../chain/realAdapter";
import {AgentLoop} from "./loop";

/**
 * The single agent instance the whole server shares.
 *
 * ## Why a global
 *
 * Next's dev server re-evaluates modules on hot reload, so a plain module-level
 * `const` would hand every edit a brand new agent: fresh bandit, empty chart, and —
 * worse — a second timer racing the first for the same nonce. Stashing it on
 * `globalThis` is the standard escape hatch for exactly this, and it is the
 * difference between a demo that survives a last-minute tweak and one that does not.
 *
 * `server-only` at the top is a build-time tripwire: importing this from a client
 * component fails the build rather than shipping `AGENT_PRIVATE_KEY` to a browser.
 */

interface Runtime {
  loop: AgentLoop;
  adapter: FullAdapter;
  mode: "mock" | "live";
}

const KEY = Symbol.for("leash.agent.runtime");
const store = globalThis as unknown as {[KEY]?: Runtime};

/**
 * Live if a vault address and an agent key are both present, mock otherwise.
 *
 * Deliberately derived rather than a separate flag someone forgets to flip. The
 * dashboard reads `mode` back and labels itself, so there is never a question of
 * whether what is on screen came from a chain — the first thing a judge will ask.
 */
export function runtime(): Runtime {
  const existing = store[KEY];
  if (existing) return existing;

  const hasChain = Boolean(process.env.VAULT_ADDRESS && process.env.AGENT_PRIVATE_KEY);

  // One adapter, shared by the loop and by direct reads, so transaction count and
  // gas accumulate in a single place. Two adapters would each count half.
  const adapter: FullAdapter = hasChain ? RealAdapter.fromEnv() : new MockAdapter();

  const created: Runtime = {
    loop: new AgentLoop(adapter),
    adapter,
    mode: hasChain ? "live" : "mock",
  };

  store[KEY] = created;
  return created;
}

/** Only used by tests, which must not inherit a loop from a previous case. */
export function resetRuntimeForTests(): void {
  store[KEY]?.loop.stop();
  delete store[KEY];
}
