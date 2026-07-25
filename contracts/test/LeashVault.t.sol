// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LeashVault} from "../src/LeashVault.sol";

/// @dev The revert tests are the point of this file. Each one asserts a limit
/// the agent physically cannot cross; a happy-path test alone would prove
/// nothing about the security property the vault exists to provide.
contract LeashVaultTest is Test {
    LeashVault internal vault;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant INITIAL_DEPOSIT = 100 ether;
    bytes32 internal constant RATIONALE = keccak256("momentum favours strategy 1");

    function setUp() public {
        // Start well inside a later epoch, and off its boundary. Epoch 0 has no
        // preceding block to anchor to, and a chain that young is not a case the
        // vault is meant to run on.
        vm.roll(100_100);
        vm.warp(1_000);

        vault = new LeashVault(owner, agent);

        vm.deal(owner, 1_000 ether);
        vm.prank(owner);
        vault.deposit{value: INITIAL_DEPOSIT}();
    }

    // ---------------------------------------------------------------------
    // Reverts: the agent cannot touch the money
    // ---------------------------------------------------------------------

    function test_RevertWhen_AgentWithdraws() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.withdraw(1 ether);
    }

    function test_RevertWhen_AgentDeposits() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.deposit{value: 1 ether}();
    }

    function test_RevertWhen_AgentRotatesAgent() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vault.setAgent(stranger);
    }

    function test_RevertWhen_StrangerWithdraws() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vault.withdraw(1 ether);
    }

    function test_RevertWhen_OwnerRebalances() public {
        vm.prank(owner);
        vm.expectRevert(LeashVault.NotAgent.selector);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);
    }

    // ---------------------------------------------------------------------
    // Reverts: weight cap
    // ---------------------------------------------------------------------

    function test_RevertWhen_WeightExceedsCap() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.WeightExceedsCap.selector, 0, 6_001));
        vault.rebalance(_weights(6_001, 3_999, 0), RATIONALE);
    }

    function test_RevertWhen_AgentPutsEverythingInOneStrategy() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.WeightExceedsCap.selector, 2, 10_000));
        vault.rebalance(_weights(0, 0, 10_000), RATIONALE);
    }

    function test_RevertWhen_WeightsDoNotSumToOne() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.WeightsMustSumToOne.selector, 9_000));
        vault.rebalance(_weights(3_000, 3_000, 3_000), RATIONALE);
    }

    function test_RevertWhen_WeightCountIsWrong() public {
        uint256[] memory short = new uint256[](2);
        short[0] = 5_000;
        short[1] = 5_000;

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.InvalidWeightCount.selector, 2, 3));
        vault.rebalance(short, RATIONALE);
    }

    // ---------------------------------------------------------------------
    // Reverts: cooldown
    // ---------------------------------------------------------------------

    function test_RevertWhen_RebalanceInsideCooldown() public {
        vm.prank(agent);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.CooldownActive.selector, 2));
        vault.rebalance(_weights(5_000, 3_000, 2_000), RATIONALE);
    }

    function test_RevertWhen_RebalanceOneSecondBeforeCooldownExpires() public {
        vm.prank(agent);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);

        vm.warp(block.timestamp + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.CooldownActive.selector, 1));
        vault.rebalance(_weights(5_000, 3_000, 2_000), RATIONALE);
    }

    // ---------------------------------------------------------------------
    // Reverts: circuit breaker
    // ---------------------------------------------------------------------

    function test_RevertWhen_AgentRebalancesWhileHalted() public {
        _driveIntoHalt();
        assertTrue(vault.isHalted(), "vault should be halted");

        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(LeashVault.VaultHalted.selector);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);
    }

    // ---------------------------------------------------------------------
    // Reverts: withdrawal bounds
    // ---------------------------------------------------------------------

    function test_RevertWhen_WithdrawExceedsBookValue() public {
        // Read the book value up front: an external call between `prank` and the
        // call under test would consume the prank.
        uint256 bookValue = vault.totalValue();
        uint256 tooMuch = bookValue + 1;

        vm.expectRevert(
            abi.encodeWithSelector(LeashVault.AmountExceedsValue.selector, tooMuch, bookValue)
        );
        vm.prank(owner);
        vault.withdraw(tooMuch);
    }

    function test_RevertWhen_WithdrawIsZero() public {
        vm.prank(owner);
        vm.expectRevert(LeashVault.ZeroAmount.selector);
        vault.withdraw(0);
    }

    // ---------------------------------------------------------------------
    // Happy paths
    // ---------------------------------------------------------------------

    function test_OwnerDepositsAndWithdraws() public {
        assertEq(vault.totalValue(), INITIAL_DEPOSIT);
        assertEq(address(vault).balance, INITIAL_DEPOSIT);

        uint256 balanceBefore = owner.balance;
        vm.prank(owner);
        vault.withdraw(40 ether);

        assertEq(owner.balance, balanceBefore + 40 ether);
        assertEq(vault.totalValue(), 60 ether);
        assertEq(address(vault).balance, 60 ether);
    }

    function test_AgentRebalancesAfterCooldown() public {
        vm.prank(agent);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);

        vm.warp(block.timestamp + vault.REBALANCE_COOLDOWN());
        vm.roll(block.number + 1);

        vm.expectEmit(true, false, false, false, address(vault));
        emit LeashVault.Rebalanced(agent, new uint256[](0), 0, 0, RATIONALE);

        vm.prank(agent);
        vault.rebalance(_weights(5_000, 3_000, 2_000), RATIONALE);

        uint256[] memory applied = vault.weights();
        assertEq(applied[0], 5_000);
        assertEq(applied[1], 3_000);
        assertEq(applied[2], 2_000);
    }

    function test_WeightExactlyAtCapIsAccepted() public {
        vm.prank(agent);
        vault.rebalance(_weights(6_000, 4_000, 0), RATIONALE);

        assertEq(vault.weights()[0], vault.MAX_WEIGHT_BPS());
    }

    function test_DrawdownTripsBreakerAndEmitsHalted() public {
        assertFalse(vault.isHalted());

        _driveIntoHalt();

        assertTrue(vault.isHalted());
        assertGt(vault.drawdownBps(), vault.MAX_DRAWDOWN_BPS());
    }

    /// @dev The property the whole design exists for: a halt locks out the
    /// agent and leaves the owner's exit untouched.
    function test_OwnerCanWithdrawWhileHalted() public {
        _driveIntoHalt();
        assertTrue(vault.isHalted());

        uint256 balanceBefore = owner.balance;
        vm.prank(owner);
        vault.withdraw(10 ether);

        assertEq(owner.balance, balanceBefore + 10 ether);
    }

    function test_StrategyRatesAreBoundedAndDeriveFromBlockData() public {
        int256 maxAbs = int256(vault.MAX_ABS_RATE_BPS());
        uint256 epochLen = vault.RATE_EPOCH_BLOCKS();

        int256[] memory before = vault.strategyRates();
        for (uint256 i = 0; i < before.length; i++) {
            assertLe(before[i], maxAbs);
            assertGe(before[i], -maxAbs);
        }

        // Same block, same rates. Nothing off-chain can move them.
        int256[] memory again = vault.strategyRates();
        assertEq(again[0], before[0]);

        // Still the same rates a block later: an agent needs a rate to sit still
        // long enough to be worth learning.
        vm.roll(block.number + 1);
        assertEq(vault.strategyRates()[0], before[0], "rate must hold within an epoch");

        vm.roll(block.number - (block.number % epochLen) + epochLen);
        int256[] memory next = vault.strategyRates();

        bool anyChanged;
        for (uint256 i = 0; i < next.length; i++) {
            if (next[i] != before[i]) anyChanged = true;
        }
        assertTrue(anyChanged, "rates should redraw across an epoch boundary");
    }

    /// @dev The verifiability half of the claim. `blockhash` returns zero past 256
    /// blocks -- about 77 seconds on Monad -- so a rate read live from a hash
    /// becomes irreproducible almost as soon as it is used. Settling pins the
    /// anchor in storage, which outlives that window.
    function test_SettledEpochRatesAreStillRecomputable() public {
        uint256 epoch = vault.currentEpoch();
        int256 rateThen = vault.strategyRateBps(1);

        _rebalanceEvenly();
        bytes32 anchor = vault.epochAnchor(epoch);

        vm.roll(block.number + 500_000);

        assertEq(vault.rateAtEpoch(epoch, 1), rateThen, "history must stay verifiable");
        assertEq(vault.epochAnchor(epoch), anchor, "the anchor must outlive blockhash");
        assertEq(vault.rateFromAnchor(anchor, 1), rateThen, "anyone can rerun the derivation");
    }

    /// @dev The unpredictability half, and the reason the anchor exists. If a
    /// future epoch's rates could be read, the agent would not be learning a
    /// market, it would be reading the answer key.
    function test_RevertWhen_ReadingAFutureEpochsRates() public {
        uint256 nextEpoch = vault.currentEpoch() + 1;

        vm.expectRevert(abi.encodeWithSelector(LeashVault.EpochNotAnchored.selector, nextEpoch));
        vault.rateAtEpoch(nextEpoch, 0);
    }

    /// @dev An epoch nobody traded through paid nobody anything, so having no rate
    /// to report for it is correct rather than a gap in the history.
    function test_RevertWhen_ReadingAnEpochThatWasNeverSettled() public {
        uint256 skipped = vault.currentEpoch();

        vm.roll(block.number + 500_000);

        vm.expectRevert(abi.encodeWithSelector(LeashVault.EpochNotAnchored.selector, skipped));
        vault.rateAtEpoch(skipped, 0);
    }

    function test_FirstRebalanceInAnEpochAnchorsItOnce() public {
        uint256 epoch = vault.currentEpoch();
        bytes32 expected = blockhash(epoch * vault.RATE_EPOCH_BLOCKS() - 1);

        vm.expectEmit(true, false, false, true, address(vault));
        emit LeashVault.EpochAnchored(epoch, expected);

        vm.prank(agent);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);

        // A second rebalance inside the same epoch must not redraw the market.
        _rebalanceEvenly();
        assertEq(vault.epochAnchor(epoch), expected, "an anchor is written once");
    }

    /// @dev {LeashVault._liveAnchor} reaches back to the block before the epoch
    /// began, and has to keep reaching it from the epoch's last block.
    function test_EpochFitsInsideTheBlockhashWindow() public view {
        assertLt(vault.RATE_EPOCH_BLOCKS(), 256, "an epoch must stay inside blockhash range");
    }

    /// @dev The weighted return the vault applied has to match an independent
    /// recomputation from the public rates, or the audit trail means nothing.
    function test_AppliedRateMatchesIndependentRecomputation() public {
        _rollIntoAdverseEpoch();

        int256 bps = int256(vault.BPS_DENOMINATOR());
        int256 expectedRate = _expectedPortfolioRateBps();
        int256 valueBefore = int256(vault.totalValue());
        int256 expectedValue = valueBefore + (valueBefore * expectedRate) / bps;

        _rebalanceEvenly();

        assertEq(
            int256(vault.totalValue()),
            expectedValue,
            "the applied return must equal what the public rates predict"
        );
    }

    /// @dev Invariant from {LeashVault._resizeBook}: moving capital in or out
    /// must not mask or manufacture a drawdown.
    function test_DepositDoesNotChangeDrawdown() public {
        _rollIntoAdverseEpoch();
        _rebalanceEvenly();

        uint256 drawdownBefore = vault.drawdownBps();
        assertGt(drawdownBefore, 0, "expected a loss to measure");

        vm.prank(owner);
        vault.deposit{value: 50 ether}();

        assertApproxEqAbs(vault.drawdownBps(), drawdownBefore, 1);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _weights(uint256 a, uint256 b, uint256 c) private pure returns (uint256[] memory w) {
        w = new uint256[](3);
        w[0] = a;
        w[1] = b;
        w[2] = c;
    }

    /// @dev Rolls forward to the next epoch in which every strategy pays at least
    /// -1%, so the loss that follows does not depend on how the book is allocated.
    /// The losing market is one the contract really produces, not one forced with
    /// `vm.setBlockhash`. Each candidate has to be rolled into before it can be
    /// read, which is the commitment property doing its job: a future epoch's
    /// rates cannot be looked up, only arrived at.
    function _rollIntoAdverseEpoch() private {
        uint256 epochLen = vault.RATE_EPOCH_BLOCKS();
        uint256 first = block.number / epochLen + 1;

        for (uint256 epoch = first; epoch < first + 2_000; epoch++) {
            vm.roll(epoch * epochLen);
            int256[] memory rates = vault.strategyRates();
            if (rates[0] <= -100 && rates[1] <= -100 && rates[2] <= -100) return;
        }
        revert("no adverse epoch within search window");
    }

    /// @dev Rebalances evenly once, advancing time past the cooldown but not the
    /// block number, so the epoch -- and therefore the market -- stays put.
    function _rebalanceEvenly() private {
        vm.warp(block.timestamp + vault.REBALANCE_COOLDOWN());
        vm.prank(agent);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);
    }

    function _driveIntoHalt() private {
        _rollIntoAdverseEpoch();
        for (uint256 i = 0; i < 200 && !vault.isHalted(); i++) {
            _rebalanceEvenly();
        }
    }

    /// @dev Recomputed here rather than read from the vault, so the test does not
    /// simply agree with the implementation it is checking.
    function _expectedPortfolioRateBps() private view returns (int256 rate) {
        uint256[] memory currentWeights = vault.weights();
        int256[] memory rates = vault.strategyRates();
        for (uint256 i = 0; i < currentWeights.length; i++) {
            rate += int256(currentWeights[i]) * rates[i];
        }
        rate /= int256(vault.BPS_DENOMINATOR());
    }
}
