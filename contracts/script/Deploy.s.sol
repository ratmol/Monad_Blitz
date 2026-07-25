// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {LeashVault} from "../src/LeashVault.sol";

/// @notice Deploys LeashVault with the broadcasting key as owner.
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
///
/// Requires in the environment:
///   PRIVATE_KEY    deployer key, becomes the vault owner
///   AGENT_ADDRESS  address the agent service signs with, may only rebalance
contract Deploy is Script {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10_143;

    error WrongChain(uint256 actual, uint256 expected);

    function run() external returns (LeashVault vault) {
        // Fail before spending gas if the RPC points somewhere unexpected. The
        // local chain id during a dry run is left alone so `forge script`
        // without --rpc-url still works.
        if (block.chainid != MONAD_TESTNET_CHAIN_ID && block.chainid != 31_337) {
            revert WrongChain(block.chainid, MONAD_TESTNET_CHAIN_ID);
        }

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address owner = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        vault = new LeashVault(owner, agent);
        vm.stopBroadcast();

        // Never log the key itself, only the address it derives to.
        console2.log("LeashVault:", address(vault));
        console2.log("owner:     ", owner);
        console2.log("agent:     ", agent);
    }
}
