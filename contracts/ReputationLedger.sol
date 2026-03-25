// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  ReputationLedger
 * @notice Aggregates all milestone performance events per contractor
 *         and exposes a read-only reputation profile consumed by the
 *         off-chain ML ranking engine (TOPSIS + Random Forest).
 *
 * @dev    Only the authorized ProjectMilestone contract may call
 *         `recordMilestone`. All read functions are free (view).
 *         This contract is the single source of truth for contractor
 *         reputation — no party can alter historical records.
 *
 * Paper:  "A Blockchain-Based Dynamic Contractor Reputation and
 *          Ranking System with Machine Learning for Transparent
 *          Construction Procurement"
 *         Mujahid Ullah Khan Afridi, NMSU Industrial Engineering
 */
contract ReputationLedger {

    // ─── Structs ─────────────────────────────────────────────────

    /**
     * @dev Aggregated performance counters for one contractor.
     *      All four BCRRS metrics (SPI, DDS, MCR, FCI) are derived
     *      from these fields by the off-chain ML engine.
     *
     *      SPI = onTimeMilestones / totalMilestones
     *            * (1 - avgDelaySecs / deltaMax)
     *      DDS = qualityScoreSum / totalMilestones          [0-100]
     *      MCR = materialCompliantCount / totalMilestones   [0-1]
     *      FCI = 1 - disputeCount / totalMilestones         [0-1]
     */
    struct ReputationProfile {
        uint256 totalMilestones;          // All completed milestones
        uint256 onTimeMilestones;         // Completed on or before plannedDate
        uint256 totalDelaySecs;           // Cumulative delay in seconds
        uint256 qualityScoreSum;          // Sum of all inspector scores
        uint256 materialCompliantCount;   // Milestones with compliant materials
        uint256 disputeCount;             // Milestones that raised a dispute
        uint256 lastUpdated;              // Timestamp of most recent milestone
        uint256 firstProjectTimestamp;    // Timestamp of first ever milestone
    }

    /**
     * @dev Yearly snapshot for annual leaderboard.
     *      Taken at end of each calendar year by the governance layer.
     */
    struct YearlySnapshot {
        uint256 year;
        uint256 totalMilestones;
        uint256 onTimeMilestones;
        uint256 qualityScoreSum;
        uint256 materialCompliantCount;
        uint256 disputeCount;
        uint256 snapshotTimestamp;
    }

    /**
     * @dev Anti-nepotism: records when an award deviates from
     *      the top-ranked BCRRS contractor.
     */
    struct DeviationEvent {
        bytes32 projectId;
        bytes32 awardedDID;
        bytes32 topRankedDID;
        uint256 scoreGap;          // In basis points (10000 = 100%)
        bytes32 justificationHash; // keccak256 of justification doc
        uint256 timestamp;
    }

    // ─── State ───────────────────────────────────────────────────

    /// @notice contractorDID => aggregated reputation profile
    mapping(bytes32 => ReputationProfile) private profiles;

    /// @notice contractorDID => year => yearly snapshot
    mapping(bytes32 => mapping(uint256 => YearlySnapshot)) public yearlySnapshots;

    /// @notice projectId => DeviationEvent (anti-nepotism log)
    mapping(bytes32 => DeviationEvent) public deviationEvents;

    /// @notice Address of the authorized ProjectMilestone contract
    address public milestoneContract;

    /// @notice Authority that can record deviation events and snapshots
    address public authority;

    /// @notice Total milestone events recorded across all contractors
    uint256 public totalMilestoneEvents;

    // ─── Events ──────────────────────────────────────────────────

    event ReputationUpdated(
        bytes32 indexed contractorDID,
        uint256         totalMilestones,
        uint8           latestQualityScore,
        bool            wasOnTime,
        bool            materialCompliant,
        uint256         timestamp
    );

    event YearlySnapshotTaken(
        bytes32 indexed contractorDID,
        uint256         year,
        uint256         totalMilestones,
        uint256         timestamp
    );

    event DeviationRecorded(
        bytes32 indexed projectId,
        bytes32 indexed awardedDID,
        bytes32 indexed topRankedDID,
        uint256         scoreGap,
        bytes32         justificationHash,
        uint256         timestamp
    );

    event MilestoneContractUpdated(
        address indexed oldContract,
        address indexed newContract
    );

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyMilestoneContract() {
        require(
            msg.sender == milestoneContract,
            "BCRRS: caller is not milestone contract"
        );
        _;
    }

    modifier onlyAuthority() {
        require(msg.sender == authority, "BCRRS: caller is not authority");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    /**
     * @param _authority         Governance authority address
     * @param _milestoneContract Initial ProjectMilestone contract address
     */
    constructor(address _authority, address _milestoneContract) {
        require(_authority        != address(0), "BCRRS: zero authority");
        require(_milestoneContract != address(0), "BCRRS: zero milestone contract");
        authority        = _authority;
        milestoneContract = _milestoneContract;
    }

    // ─── Write Functions (restricted) ────────────────────────────

    /**
     * @notice Record a completed milestone event for a contractor.
     * @dev    Called exclusively by ProjectMilestone.completeMilestone().
     *         Updates all four reputation metric accumulators atomically.
     *
     * @param _did               Contractor DID
     * @param _plannedDate       Planned completion timestamp
     * @param _actualDate        Actual completion timestamp
     * @param _qualityScore      Inspector quality score [0-100]
     * @param _materialCompliant Whether materials matched specification
     * @param _disputeRaised     Whether a dispute was raised
     */
    function recordMilestone(
        bytes32 _did,
        uint256 _plannedDate,
        uint256 _actualDate,
        uint8   _qualityScore,
        bool    _materialCompliant,
        bool    _disputeRaised
    ) external onlyMilestoneContract {
        require(_did != bytes32(0),       "BCRRS: invalid DID");
        require(_qualityScore <= 100,     "BCRRS: score out of range");
        require(_actualDate > 0,          "BCRRS: invalid actual date");
        require(_plannedDate > 0,         "BCRRS: invalid planned date");

        ReputationProfile storage rp = profiles[_did];

        // Initialise first project timestamp
        if (rp.firstProjectTimestamp == 0) {
            rp.firstProjectTimestamp = _actualDate;
        }

        rp.totalMilestones++;
        totalMilestoneEvents++;

        bool onTime = _actualDate <= _plannedDate;
        if (onTime) {
            rp.onTimeMilestones++;
        } else {
            rp.totalDelaySecs += _actualDate - _plannedDate;
        }

        rp.qualityScoreSum += _qualityScore;

        if (_materialCompliant) rp.materialCompliantCount++;
        if (_disputeRaised)     rp.disputeCount++;

        rp.lastUpdated = block.timestamp;

        emit ReputationUpdated(
            _did,
            rp.totalMilestones,
            _qualityScore,
            onTime,
            _materialCompliant,
            block.timestamp
        );
    }

    /**
     * @notice Take an immutable yearly snapshot for the annual leaderboard.
     * @dev    Called by the governance layer at end of each calendar year.
     *         Snapshot is permanent and cannot be overwritten.
     *
     * @param _did   Contractor DID
     * @param _year  Calendar year (e.g. 2025)
     */
    function takeYearlySnapshot(
        bytes32 _did,
        uint256 _year
    ) external onlyAuthority {
        require(_did  != bytes32(0), "BCRRS: invalid DID");
        require(_year > 2020,        "BCRRS: invalid year");
        require(
            yearlySnapshots[_did][_year].snapshotTimestamp == 0,
            "BCRRS: snapshot already taken for this year"
        );

        ReputationProfile storage rp = profiles[_did];

        yearlySnapshots[_did][_year] = YearlySnapshot({
            year                  : _year,
            totalMilestones       : rp.totalMilestones,
            onTimeMilestones      : rp.onTimeMilestones,
            qualityScoreSum       : rp.qualityScoreSum,
            materialCompliantCount: rp.materialCompliantCount,
            disputeCount          : rp.disputeCount,
            snapshotTimestamp     : block.timestamp
        });

        emit YearlySnapshotTaken(_did, _year, rp.totalMilestones, block.timestamp);
    }

    /**
     * @notice Record an award deviation event (anti-nepotism log).
     * @dev    Called when authority detects an award to a contractor
     *         ranked below the top 3 BCRRS candidates.
     *         Justification document hash must be provided.
     *
     * @param _projectId         Project identifier
     * @param _awardedDID        DID of awarded (potentially lower-ranked) contractor
     * @param _topRankedDID      DID of top BCRRS-ranked contractor
     * @param _scoreGap          Score difference in basis points
     * @param _justificationHash keccak256 of written justification document
     */
    function recordDeviationEvent(
        bytes32 _projectId,
        bytes32 _awardedDID,
        bytes32 _topRankedDID,
        uint256 _scoreGap,
        bytes32 _justificationHash
    ) external onlyAuthority {
        require(_projectId        != bytes32(0), "BCRRS: invalid project ID");
        require(_awardedDID       != bytes32(0), "BCRRS: invalid awarded DID");
        require(_topRankedDID     != bytes32(0), "BCRRS: invalid top DID");
        require(_justificationHash != bytes32(0), "BCRRS: justification required");
        require(
            deviationEvents[_projectId].timestamp == 0,
            "BCRRS: deviation already recorded for project"
        );

        deviationEvents[_projectId] = DeviationEvent({
            projectId         : _projectId,
            awardedDID        : _awardedDID,
            topRankedDID      : _topRankedDID,
            scoreGap          : _scoreGap,
            justificationHash : _justificationHash,
            timestamp         : block.timestamp
        });

        emit DeviationRecorded(
            _projectId,
            _awardedDID,
            _topRankedDID,
            _scoreGap,
            _justificationHash,
            block.timestamp
        );
    }

    /**
     * @notice Update the authorized milestone contract address.
     * @dev    Required if milestone contract is upgraded.
     */
    function setMilestoneContract(
        address _newMilestoneContract
    ) external onlyAuthority {
        require(_newMilestoneContract != address(0), "BCRRS: zero address");
        emit MilestoneContractUpdated(milestoneContract, _newMilestoneContract);
        milestoneContract = _newMilestoneContract;
    }

    // ─── View Functions (free, public) ───────────────────────────

    /**
     * @notice Get full aggregated reputation profile for a contractor.
     * @param _did Contractor DID
     * @return     ReputationProfile struct with all accumulators
     */
    function getProfile(
        bytes32 _did
    ) external view returns (ReputationProfile memory) {
        return profiles[_did];
    }

    /**
     * @notice Get yearly snapshot for a contractor and year.
     * @param _did   Contractor DID
     * @param _year  Calendar year
     * @return       YearlySnapshot struct
     */
    function getYearlySnapshot(
        bytes32 _did,
        uint256 _year
    ) external view returns (YearlySnapshot memory) {
        return yearlySnapshots[_did][_year];
    }

    /**
     * @notice Compute Schedule Performance Index (SPI) for a contractor.
     * @dev    SPI = onTimeMilestones / totalMilestones
     *         Returns value scaled by 1e4 (10000 = 1.0) to avoid floats.
     * @param _did       Contractor DID
     * @param _deltaMax  Maximum delay normalisation constant in seconds
     *                   (e.g. 90 days = 7776000)
     */
    function computeSPI(
        bytes32 _did,
        uint256 _deltaMax
    ) external view returns (uint256 spi_scaled) {
        ReputationProfile storage rp = profiles[_did];
        if (rp.totalMilestones == 0) return 0;

        uint256 onTimeRatio = (rp.onTimeMilestones * 1e4) / rp.totalMilestones;

        uint256 avgDelaySecs = rp.totalMilestones > rp.onTimeMilestones
            ? rp.totalDelaySecs / (rp.totalMilestones - rp.onTimeMilestones)
            : 0;

        uint256 delayPenalty = avgDelaySecs >= _deltaMax
            ? 1e4
            : (avgDelaySecs * 1e4) / _deltaMax;

        spi_scaled = onTimeRatio * (1e4 - delayPenalty) / 1e4;
    }

    /**
     * @notice Compute Defect Density Score (DDS) for a contractor.
     * @dev    DDS = qualityScoreSum / totalMilestones  [0-100]
     *         Returns value scaled by 1e2.
     */
    function computeDDS(bytes32 _did) external view returns (uint256) {
        ReputationProfile storage rp = profiles[_did];
        if (rp.totalMilestones == 0) return 0;
        return (rp.qualityScoreSum * 1e2) / rp.totalMilestones;
    }

    /**
     * @notice Compute Material Compliance Rate (MCR) for a contractor.
     * @dev    MCR = materialCompliantCount / totalMilestones  [0-1]
     *         Returns value scaled by 1e4 (10000 = 1.0).
     */
    function computeMCR(bytes32 _did) external view returns (uint256) {
        ReputationProfile storage rp = profiles[_did];
        if (rp.totalMilestones == 0) return 0;
        return (rp.materialCompliantCount * 1e4) / rp.totalMilestones;
    }

    /**
     * @notice Compute Financial Conduct Index (FCI) for a contractor.
     * @dev    FCI = 1 - disputeCount / totalMilestones  [0-1]
     *         Returns value scaled by 1e4 (10000 = 1.0).
     */
    function computeFCI(bytes32 _did) external view returns (uint256) {
        ReputationProfile storage rp = profiles[_did];
        if (rp.totalMilestones == 0) return 1e4; // No history = no disputes
        return 1e4 - (rp.disputeCount * 1e4) / rp.totalMilestones;
    }

    /**
     * @notice Check whether a deviation event exists for a project.
     */
    function hasDeviationEvent(bytes32 _projectId) external view returns (bool) {
        return deviationEvents[_projectId].timestamp > 0;
    }
}
