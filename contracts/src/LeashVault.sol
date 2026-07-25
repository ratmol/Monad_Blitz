// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LeashVault
/// @notice A vault whose capital is allocated by an untrusted autonomous agent.
///
/// The security property this contract exists to enforce: the agent can change
/// how capital is split across strategies and nothing else. It cannot move a
/// single wei out of the vault, it cannot concentrate the book past a cap, it
/// cannot act faster than a cooldown, and it is cut off automatically once the
/// book has drawn down past a threshold from its high water mark.
///
/// Strategy returns are derived from block data rather than supplied by the
/// caller, so the off-chain service that drives the agent cannot fabricate a
/// favourable market. Anyone can recompute a period's returns from the chain.
contract LeashVault is Ownable, ReentrancyGuard {
    /// @dev All ratios in this contract are basis points: 10_000 bps == 100%.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Number of strategies the book is split across.
    uint256 public constant STRATEGY_COUNT = 3;

    /// @notice No single strategy may hold more than 60% of the book.
    uint256 public constant MAX_WEIGHT_BPS = 6_000;

    /// @notice Minimum time between two rebalances.
    uint256 public constant REBALANCE_COOLDOWN = 2 seconds;

    /// @notice Drawdown from the high water mark that trips the circuit breaker.
    uint256 public constant MAX_DRAWDOWN_BPS = 1_500;

    /// @notice Per-period strategy return is uniform over [-2%, +2%].
    uint256 public constant MAX_ABS_RATE_BPS = 200;

    /// @notice The only address allowed to call {rebalance}.
    address public agent;

    /// @notice Simulated book value in wei. See {withdraw} for how this relates
    /// to the real ether balance.
    uint256 public totalValue;

    /// @notice Highest `totalValue` ever reached, used as the drawdown reference.
    uint256 public highWaterMark;

    /// @notice Timestamp of the last settled rebalance.
    uint256 public lastRebalanceAt;

    /// @notice Once true the agent is permanently cut off. The owner is not.
    bool public isHalted;

    uint256[] private _weights;

    event Deposited(address indexed owner, uint256 amount, uint256 totalValue);
    event Withdrawn(address indexed owner, uint256 amount, uint256 totalValue);
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event Rebalanced(
        address indexed agent,
        uint256[] weights,
        int256 portfolioRateBps,
        uint256 totalValue,
        bytes32 rationaleHash
    );
    event Halted(uint256 highWaterMark, uint256 totalValue, uint256 drawdownBps);

    error NotAgent();
    error VaultHalted();
    error CooldownActive(uint256 secondsRemaining);
    error InvalidWeightCount(uint256 provided, uint256 expected);
    error WeightExceedsCap(uint256 strategyId, uint256 weightBps);
    error WeightsMustSumToOne(uint256 totalBps);
    error ZeroAddress();
    error ZeroAmount();
    error AmountExceedsValue(uint256 amount, uint256 totalValue);
    error InsufficientLiquidity(uint256 amount, uint256 balance);
    error WithdrawFailed();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier notHalted() {
        if (isHalted) revert VaultHalted();
        _;
    }

    constructor(address initialOwner, address initialAgent) Ownable(initialOwner) {
        if (initialOwner == address(0) || initialAgent == address(0)) revert ZeroAddress();
        agent = initialAgent;

        // Start from an even split. 10_000 does not divide by 3, so the last
        // strategy absorbs the remainder to keep the sum exact.
        _weights = new uint256[](STRATEGY_COUNT);
        uint256 even = BPS_DENOMINATOR / STRATEGY_COUNT;
        for (uint256 i = 0; i < STRATEGY_COUNT - 1; i++) {
            _weights[i] = even;
        }
        _weights[STRATEGY_COUNT - 1] = BPS_DENOMINATOR - (even * (STRATEGY_COUNT - 1));

        emit AgentUpdated(address(0), initialAgent);
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    /// @notice Add capital to the vault. Owner only, and deliberately so: the
    /// agent has no funding path it could use to distort its own performance.
    function deposit() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        _resizeBook(totalValue + msg.value);
        emit Deposited(msg.sender, msg.value, totalValue);
    }

    /// @notice Remove capital from the vault. Owner only, and callable even when
    /// the vault is halted -- a tripped circuit breaker locks out the agent, and
    /// must never lock the owner out of their own money.
    /// @dev `totalValue` is a simulated performance figure that drifts with the
    /// strategy returns, while ether in this contract is real. The two are
    /// checked separately so a book that has grown on paper cannot be used to
    /// withdraw ether that was never deposited.
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalValue) revert AmountExceedsValue(amount, totalValue);
        if (amount > address(this).balance) {
            revert InsufficientLiquidity(amount, address(this).balance);
        }

        _resizeBook(totalValue - amount);
        emit Withdrawn(msg.sender, amount, totalValue);

        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert WithdrawFailed();
    }

    /// @notice Rotate the agent key, for example after a suspected compromise.
    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        emit AgentUpdated(agent, newAgent);
        agent = newAgent;
    }

    // ---------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------

    /// @notice Settle the period that just ended, then apply a new allocation.
    /// This is the entire surface the agent is permitted to touch.
    /// @param targetWeights Target allocation in bps, one entry per strategy,
    /// summing to 10_000 with no entry above {MAX_WEIGHT_BPS}.
    /// @param rationaleHash Commitment to the agent's off-chain reasoning, so the
    /// decision history can be reconstructed and audited from logs alone.
    function rebalance(uint256[] calldata targetWeights, bytes32 rationaleHash)
        external
        onlyAgent
        notHalted
    {
        uint256 elapsed = block.timestamp - lastRebalanceAt;
        if (lastRebalanceAt != 0 && elapsed < REBALANCE_COOLDOWN) {
            revert CooldownActive(REBALANCE_COOLDOWN - elapsed);
        }

        _validateWeights(targetWeights);

        lastRebalanceAt = block.timestamp;

        int256 portfolioRateBps = _settle();

        // The breaker tripping is itself a state change worth keeping, so this
        // call succeeds and simply declines to apply the new allocation. Every
        // later rebalance reverts on `notHalted`.
        if (_tripBreakerIfDrawn()) return;

        _weights = targetWeights;
        emit Rebalanced(msg.sender, targetWeights, portfolioRateBps, totalValue, rationaleHash);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Current allocation in bps.
    function weights() external view returns (uint256[] memory) {
        return _weights;
    }

    /// @notice This period's return for one strategy, in bps, possibly negative.
    /// @dev Derived from the previous block hash, which no caller can choose.
    /// An agent can still influence *when* it observes a rate by choosing when to
    /// send the transaction; it can never influence what the rate is.
    function strategyRateBps(uint256 strategyId) public view returns (int256) {
        uint256 seed = uint256(
            keccak256(abi.encodePacked(blockhash(block.number - 1), block.number, strategyId))
        );
        uint256 span = 2 * MAX_ABS_RATE_BPS + 1;
        // Both casts are of values bounded by `span` (401), far inside int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(seed % span) - int256(MAX_ABS_RATE_BPS);
    }

    /// @notice This period's return for every strategy, in bps.
    function strategyRates() public view returns (int256[] memory rates) {
        rates = new int256[](STRATEGY_COUNT);
        for (uint256 i = 0; i < STRATEGY_COUNT; i++) {
            rates[i] = strategyRateBps(i);
        }
    }

    /// @notice Drawdown from the high water mark in bps. Zero at a new high.
    function drawdownBps() public view returns (uint256) {
        if (highWaterMark == 0 || totalValue >= highWaterMark) return 0;
        return ((highWaterMark - totalValue) * BPS_DENOMINATOR) / highWaterMark;
    }

    /// @notice Everything the off-chain reader needs, in a single call.
    function getState()
        external
        view
        returns (
            uint256[] memory currentWeights,
            uint256 bookValue,
            bool halted,
            int256[] memory rates
        )
    {
        return (_weights, totalValue, isHalted, strategyRates());
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _validateWeights(uint256[] calldata newWeights) private pure {
        if (newWeights.length != STRATEGY_COUNT) {
            revert InvalidWeightCount(newWeights.length, STRATEGY_COUNT);
        }

        uint256 sumBps;
        for (uint256 i = 0; i < STRATEGY_COUNT; i++) {
            if (newWeights[i] > MAX_WEIGHT_BPS) revert WeightExceedsCap(i, newWeights[i]);
            sumBps += newWeights[i];
        }
        if (sumBps != BPS_DENOMINATOR) revert WeightsMustSumToOne(sumBps);
    }

    /// @dev Applies the period's return to the book under the *outgoing* weights,
    /// which is the allocation that was actually exposed to it.
    /// @return portfolioRateBps The weighted return applied, in bps.
    function _settle() private returns (int256 portfolioRateBps) {
        for (uint256 i = 0; i < STRATEGY_COUNT; i++) {
            // Each weight is validated at or below BPS_DENOMINATOR (10_000).
            // forge-lint: disable-next-line(unsafe-typecast)
            portfolioRateBps += int256(_weights[i]) * strategyRateBps(i);
        }
        // Weights sum to BPS_DENOMINATOR, so this divides the weighted sum back
        // down to a plain bps rate. Solidity truncates toward zero.
        // forge-lint: disable-next-line(unsafe-typecast)
        portfolioRateBps /= int256(BPS_DENOMINATOR);

        // `totalValue` is bounded by the ether ever deposited, so it stays many
        // orders of magnitude below int256 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 delta = (int256(totalValue) * portfolioRateBps) / int256(BPS_DENOMINATOR);

        // |portfolioRateBps| <= MAX_ABS_RATE_BPS, so |delta| is at most 2% of the
        // book and the sum can never go negative.
        // forge-lint: disable-next-line(unsafe-typecast)
        totalValue = uint256(int256(totalValue) + delta);

        if (totalValue > highWaterMark) highWaterMark = totalValue;
    }

    function _tripBreakerIfDrawn() private returns (bool tripped) {
        uint256 drawdown = drawdownBps();
        if (drawdown <= MAX_DRAWDOWN_BPS) return false;

        isHalted = true;
        emit Halted(highWaterMark, totalValue, drawdown);
        return true;
    }

    /// @dev Moves the book to `newTotalValue` and scales the high water mark by
    /// the same factor. Invariant: a deposit or withdrawal must leave
    /// {drawdownBps} unchanged, so moving capital can never mask a drawdown or
    /// manufacture one.
    function _resizeBook(uint256 newTotalValue) private {
        if (totalValue == 0) {
            highWaterMark = newTotalValue;
        } else {
            highWaterMark = (highWaterMark * newTotalValue) / totalValue;
        }
        totalValue = newTotalValue;
    }
}
