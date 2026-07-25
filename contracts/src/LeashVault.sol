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
/// favourable market. Each epoch's market is committed to the hash of the block
/// before it began: unknowable until that block is mined, and stored on first
/// use so anyone can recompute a past period's returns from the chain forever.
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

    /// @notice Blocks a strategy's rate holds for before it is redrawn.
    /// @dev At Monad's ~300ms blocks this is about a minute, or roughly twenty
    /// rebalances at a 3s tick. The agent needs a rate to persist across enough
    /// observations to be worth learning; a rate that is redrawn every block gives
    /// every strategy the same expected return at every instant, and an agent on
    /// top of that is indistinguishable from noise no matter how good it is.
    ///
    /// Must stay strictly below the 256 block `blockhash` window. An epoch is
    /// anchored to the hash of the block before it began, and that hash has to
    /// still be readable at every block in the epoch for {_liveAnchor} to work.
    uint256 public constant RATE_EPOCH_BLOCKS = 200;

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

    /// @dev Epoch => the block hash its market was drawn from. Written once, on
    /// the first rebalance that settles inside the epoch, and never overwritten.
    mapping(uint256 => bytes32) private _epochAnchors;

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
    event EpochAnchored(uint256 indexed epoch, bytes32 anchor);

    error NotAgent();
    error EpochNotAnchored(uint256 epoch);
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

        // Pin this epoch's market into storage before settling against it, so the
        // period the agent was just paid for stays verifiable after the block hash
        // it came from has aged out of the EVM's 256 block window.
        int256 portfolioRateBps = _settle(_anchorEpoch(currentEpoch()));

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

    /// @notice The epoch the chain is currently in.
    function currentEpoch() public view returns (uint256) {
        return block.number / RATE_EPOCH_BLOCKS;
    }

    /// @notice The block hash an epoch's market was drawn from, or zero if that
    /// epoch has neither been settled nor started.
    function epochAnchor(uint256 epoch) external view returns (bytes32) {
        bytes32 stored = _epochAnchors[epoch];
        return stored != bytes32(0) ? stored : _liveAnchor(epoch);
    }

    /// @notice This period's return for one strategy, in bps, possibly negative.
    /// @dev An agent can influence *when* it observes a rate by choosing when to
    /// send its transaction; it can never influence what the rate is, and cannot
    /// know it before the epoch starts.
    function strategyRateBps(uint256 strategyId) public view returns (int256) {
        return rateAtEpoch(currentEpoch(), strategyId);
    }

    /// @notice The rate a strategy paid in a settled or currently running epoch.
    /// @dev Reverts for an epoch that has not begun -- that is the point. The rate
    /// is a function of a block hash that does not exist yet, so neither the agent
    /// nor anyone else can compute a future market and allocate against it.
    /// Reverts equally for a past epoch nobody ever rebalanced in: no rate was
    /// applied then, so there is nothing to verify.
    function rateAtEpoch(uint256 epoch, uint256 strategyId) public view returns (int256) {
        return rateFromAnchor(_requireAnchor(epoch), strategyId);
    }

    /// @notice The derivation itself, given an epoch's anchor.
    /// @dev Pure and public on purpose. "Anyone can verify our market" is only true
    /// if anyone can actually run the derivation, so this is the claim made
    /// executable: read the anchor out of an EpochAnchored log, run this off-chain,
    /// compare against the Rebalanced logs from that period.
    function rateFromAnchor(bytes32 anchor, uint256 strategyId) public pure returns (int256) {
        uint256 seed = uint256(keccak256(abi.encode(anchor, strategyId)));
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

    /// @dev The hash of the block immediately before `epoch` began. Zero when the
    /// epoch has not started, or when its start has aged past the 256 block
    /// `blockhash` window; inside a running epoch it is always readable, because
    /// {RATE_EPOCH_BLOCKS} is smaller than that window.
    function _liveAnchor(uint256 epoch) private view returns (bytes32) {
        uint256 epochStart = epoch * RATE_EPOCH_BLOCKS;
        if (epochStart == 0) return bytes32(0);
        return blockhash(epochStart - 1);
    }

    function _requireAnchor(uint256 epoch) private view returns (bytes32 anchor) {
        anchor = _epochAnchors[epoch];
        if (anchor != bytes32(0)) return anchor;

        anchor = _liveAnchor(epoch);
        if (anchor == bytes32(0)) revert EpochNotAnchored(epoch);
    }

    /// @dev Stores an epoch's anchor the first time the epoch is settled. One
    /// SSTORE per epoch buys permanent recomputability of that epoch's market.
    function _anchorEpoch(uint256 epoch) private returns (bytes32 anchor) {
        anchor = _epochAnchors[epoch];
        if (anchor != bytes32(0)) return anchor;

        anchor = _liveAnchor(epoch);
        if (anchor == bytes32(0)) revert EpochNotAnchored(epoch);

        _epochAnchors[epoch] = anchor;
        emit EpochAnchored(epoch, anchor);
    }

    /// @dev Applies the period's return to the book under the *outgoing* weights,
    /// which is the allocation that was actually exposed to it.
    /// @return portfolioRateBps The weighted return applied, in bps.
    function _settle(bytes32 anchor) private returns (int256 portfolioRateBps) {
        for (uint256 i = 0; i < STRATEGY_COUNT; i++) {
            // Each weight is validated at or below BPS_DENOMINATOR (10_000).
            // forge-lint: disable-next-line(unsafe-typecast)
            portfolioRateBps += int256(_weights[i]) * rateFromAnchor(anchor, i);
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
