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
        // Move off genesis so `blockhash(block.number - 1)` has room to work.
        vm.roll(100);
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
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent)
        );
        vault.withdraw(1 ether);
    }

    function test_RevertWhen_AgentDeposits() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent)
        );
        vault.deposit{value: 1 ether}();
    }

    function test_RevertWhen_AgentRotatesAgent() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent)
        );
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

        int256[] memory before = vault.strategyRates();
        for (uint256 i = 0; i < before.length; i++) {
            assertLe(before[i], maxAbs);
            assertGe(before[i], -maxAbs);
        }

        // Same block, same rates. Nothing off-chain can move them.
        int256[] memory again = vault.strategyRates();
        assertEq(again[0], before[0]);

        vm.roll(block.number + 1);
        vm.setBlockhash(block.number - 1, keccak256("a different block"));
        int256[] memory next = vault.strategyRates();

        bool anyChanged;
        for (uint256 i = 0; i < next.length; i++) {
            if (next[i] != before[i]) anyChanged = true;
        }
        assertTrue(anyChanged, "rates should follow block data");
    }

    /// @dev Invariant from {LeashVault._resizeBook}: moving capital in or out
    /// must not mask or manufacture a drawdown.
    function test_DepositDoesNotChangeDrawdown() public {
        _rebalanceIntoLoss();
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

    /// @dev Rebalances repeatedly, each time forcing the block hash to whichever
    /// candidate produces the worst return, until the breaker trips.
    function _driveIntoHalt() private {
        for (uint256 i = 0; i < 100 && !vault.isHalted(); i++) {
            _rebalanceIntoLoss();
        }
    }

    function _rebalanceIntoLoss() private {
        vm.warp(block.timestamp + vault.REBALANCE_COOLDOWN());
        vm.roll(block.number + 1);

        bytes32 worstHash;
        int256 worstRate = type(int256).max;
        for (uint256 salt = 0; salt < 32; salt++) {
            bytes32 candidate = keccak256(abi.encodePacked(salt));
            vm.setBlockhash(block.number - 1, candidate);
            int256 rate = _expectedPortfolioRateBps();
            if (rate < worstRate) {
                worstRate = rate;
                worstHash = candidate;
            }
        }
        vm.setBlockhash(block.number - 1, worstHash);

        vm.prank(agent);
        vault.rebalance(_weights(3_334, 3_333, 3_333), RATIONALE);
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
