import {defineChain} from "viem";

import {MONAD_EXPLORER_URL, MONAD_RPC_URL, MONAD_TESTNET_CHAIN_ID} from "./constants";

/**
 * Monad testnet, defined locally rather than imported from `viem/chains` so the
 * chain id, RPC, and explorer all come from one place we control. Mainnet
 * launched in November 2025; this project targets testnet only.
 */
export const monadTestnet = defineChain({
  id: MONAD_TESTNET_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
  rpcUrls: {
    default: {http: [MONAD_RPC_URL]},
  },
  blockExplorers: {
    default: {name: "Monad Explorer", url: MONAD_EXPLORER_URL},
  },
  testnet: true,
});
