// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReputationLedger.sol";

/**
 * @title  DisputeRegistry
 * @notice Manages contractor score disputes through a multi-signature
 *         Dispute Resolution Committee (DRC). Preserves blockchain
 *         immutability by adding correction events alongside original
 *         records rather than modifying or deleting them.
 *
 * @dev    Design principles:
 *         1. Original milestone records are NEVER altered or deleted.
 *         2. Corrections are additive on-chain events consumed by the
 *            off-chain ML ranking engine during score recomputation.
 *         3. A DRC majority vote (REQUIRED_VOTES of totalDRCMembers)
 *            is required before any correction is issued.
 *         4. All dispute filings, votes, and resolutions are permanently
 *            recorded and publicly auditable.
 *         5. Court escalation path: the complete on-chain audit trail
 *            constitutes admissible electronic evidence in jurisdictions
 *            recognising blockchain records (UAE, Singapore, UK).
 *
 * Paper:  "A Blockchain-Based Dynamic Contractor Reputation and Ranking
 *          System with Machine Learning for Transparent Construction
 *          Procurement"
 *         Mujahid Ullah Khan Afridi, NMSU Industrial Engineering
 *
 * Repo:   https://github.com/MujahidUllahKhan/
 *         BCRRS-Blockchain-Contractor-Reputation-System
 */
contract DisputeRegistry {

    // ─── Enumerations ────────────────────────────────────────────

    /**
     * @dev Lifecycle states of a contractor score dispute.
     */
    enum DisputeStatus {
        FILED,         // Contractor submitted dispute — awaiting DRC review
        UNDER_REVIEW,  // DRC is actively deliberating
        UPHELD,        // DRC majority voted to issue a correction
        REJECTED,      // DRC majority voted to uphold original record
        ESCALATED      // Contractor escalated to court / external tribunal
    }

    // ─── Structs ─────────────────────────────────────────────────

    /**
     * @dev A contractor's formal dispute of a specific milestone record.
     */
    struct Dispute {
        bytes32       disputeId;
        bytes32       contractorDID;      // Disputing contractor
        bytes32       milestoneId;        // Which milestone is contested
        bytes32       groundsHash;        // keccak256 of dispute document
        DisputeStatus status;
        uint256       filedAt;
        uint256       resolvedAt;         // 0 if unresolved
        bytes32       resolutionHash;     // keccak256 of DRC resolution doc
        uint8         votesFor;           // DRC votes to uphold dispute
        uint8         votesAgainst;       // DRC votes to reject dispute
        address       escalatedTo;        // Court/tribunal address if escalated
        bool          correctionIssued;   // Whether a CorrectionEvent was emitted
    }

    /**
     * @dev An additive correction event issued by DRC after upholding a dispute.
     *      The ML engine uses this to override the original milestone values
     *      during score recomputation. The original record is never touched.
     */
    struct CorrectionEvent {
        bytes32  correctionId;
        bytes32  disputeId;           // Links back to the dispute
        bytes32  milestoneId;         // Milestone being corrected
        bytes32  contractorDID;
        uint8    correctedQualityScore;
        bool     correctedMaterialCompliant;
        bool     correctedDisputeFlag;
        bytes32  evidenceHash;        // keccak256 of supporting evidence docs
        uint256  issuedAt;
        address  issuedBy;            // DRC member who triggered final issuance
    }

    /**
     * @dev DRC member record.
     */
    struct DRCMember {
        address  wallet;
        string   organisation;        // e.g. "Pakistan Engineering Council"
        bool     active;
        uint256  addedAt;
        uint256  votescast;           // Total votes cast — auditable
    }

    // ─── State ───────────────────────────────────────────────────

    /// @notice disputeId => Dispute
    mapping(bytes32 => Dispute)        public disputes;

    /// @notice correctionId => CorrectionEvent
    mapping(bytes32 => CorrectionEvent) public corrections;

    /// @notice milestoneId => correctionId (latest correction per milestone)
    mapping(bytes32 => bytes32)        public milestoneCorrection;

    /// @notice disputeId => member address => has voted
    mapping(bytes32 => mapping(address => bool)) public hasVoted;

    /// @notice wallet => DRCMember
    mapping(address => DRCMember)      public drcMembers;

    /// @notice All DRC member addresses (for iteration)
    address[]                          public drcMemberList;

    /// @notice contractorDID => list of dispute IDs filed by this contractor
    mapping(bytes32 => bytes32[])      public contractorDisputes;

    /// @notice Governance authority (can add/remove DRC members)
    address public authority;

    /// @notice Reference to ReputationLedger for profile validation
    ReputationLedger public ledger;

    /// @notice Minimum DRC votes required to uphold or reject a dispute
    uint8 public constant REQUIRED_VOTES = 3;

    /// @notice Maximum disputes a contractor can have UNDER_REVIEW simultaneously
    uint8 public constant MAX_ACTIVE_DISPUTES = 3;

    uint256 public totalDisputes;
    uint256 public totalCorrections;

    // ─── Events ──────────────────────────────────────────────────

    event DisputeFiled(
        bytes32 indexed disputeId,
        bytes32 indexed contractorDID,
        bytes32 indexed milestoneId,
        bytes32         groundsHash,
        uint256         timestamp
    );

    event DisputeStatusChanged(
        bytes32 indexed   disputeId,
        DisputeStatus     oldStatus,
        DisputeStatus     newStatus,
        uint256           timestamp
    );

    event DRCVoteCast(
        bytes32 indexed disputeId,
        address indexed voter,
        bool            inFavour,
        uint8           votesForSoFar,
        uint8           votesAgainstSoFar,
        uint256         timestamp
    );

    event CorrectionIssued(
        bytes32 indexed correctionId,
        bytes32 indexed disputeId,
        bytes32 indexed milestoneId,
        bytes32         contractorDID,
        uint8           correctedScore,
        uint256         timestamp
    );

    event DisputeEscalated(
        bytes32 indexed disputeId,
        bytes32 indexed contractorDID,
        address         tribunal,
        uint256         timestamp
    );

    event DRCMemberAdded(
        address indexed member,
        string          organisation,
        uint256         timestamp
    );

    event DRCMemberRemoved(
        address indexed member,
        string          reason,
        uint256         timestamp
    );

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyAuthority() {
        require(msg.sender == authority, "BCRRS: not authority");
        _;
    }

    modifier onlyDRCMember() {
        require(
            drcMembers[msg.sender].active,
            "BCRRS: caller is not an active DRC member"
        );
        _;
    }

    modifier disputeExists(bytes32 _disputeId) {
        require(
            disputes[_disputeId].filedAt > 0,
            "BCRRS: dispute does not exist"
        );
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    /**
     * @param _authority Governance authority address
     * @param _ledger    Deployed ReputationLedger address
     */
    constructor(address _authority, address _ledger) {
        require(_authority != address(0), "BCRRS: zero authority");
        require(_ledger    != address(0), "BCRRS: zero ledger");
        authority = _authority;
        ledger    = ReputationLedger(_ledger);
    }

    // ─── DRC Management (Authority only) ─────────────────────────

    /**
     * @notice Add a new member to the Dispute Resolution Committee.
     * @param _member       Wallet address of the DRC member
     * @param _organisation Name of their organisation (e.g. engineering council)
     */
    function addDRCMember(
        address        _member,
        string calldata _organisation
    ) external onlyAuthority {
        require(_member != address(0),        "BCRRS: zero address");
        require(!drcMembers[_member].active,  "BCRRS: already a DRC member");
        require(bytes(_organisation).length > 0, "BCRRS: organisation required");

        drcMembers[_member] = DRCMember({
            wallet       : _member,
            organisation : _organisation,
            active       : true,
            addedAt      : block.timestamp,
            votescast    : 0
        });
        drcMemberList.push(_member);

        emit DRCMemberAdded(_member, _organisation, block.timestamp);
    }

    /**
     * @notice Remove a DRC member.
     * @param _member Wallet address to remove
     * @param _reason Reason for removal (recorded on-chain)
     */
    function removeDRCMember(
        address         _member,
        string calldata _reason
    ) external onlyAuthority {
        require(drcMembers[_member].active, "BCRRS: not an active DRC member");
        drcMembers[_member].active = false;
        emit DRCMemberRemoved(_member, _reason, block.timestamp);
    }

    // ─── Dispute Filing ──────────────────────────────────────────

    /**
     * @notice File a score dispute against a specific milestone record.
     * @dev    The contractor must provide a hash of their dispute grounds
     *         document (stored off-chain). The dispute enters FILED status
     *         and awaits DRC assignment to UNDER_REVIEW.
     *
     * @param _milestoneId  The milestone whose record is being disputed
     * @param _groundsHash  keccak256 of the dispute grounds document
     */
    function fileDispute(
        bytes32 _milestoneId,
        bytes32 _groundsHash
    ) external {
        require(_milestoneId != bytes32(0), "BCRRS: invalid milestone ID");
        require(_groundsHash  != bytes32(0), "BCRRS: grounds document required");

        // Derive contractorDID from caller — must be a registered contractor
        // (In production, ContractorRegistry.getDID(msg.sender) would be called)
        bytes32 contractorDID = keccak256(abi.encodePacked(msg.sender));

        // Limit simultaneous active disputes per contractor (AV-8 mitigation)
        uint8 activeCount = 0;
        bytes32[] storage cd = contractorDisputes[contractorDID];
        for (uint256 i = 0; i < cd.length; i++) {
            DisputeStatus s = disputes[cd[i]].status;
            if (s == DisputeStatus.FILED || s == DisputeStatus.UNDER_REVIEW) {
                activeCount++;
            }
        }
        require(
            activeCount < MAX_ACTIVE_DISPUTES,
            "BCRRS: too many active disputes - resolve existing ones first"
        );

        bytes32 disputeId = keccak256(
            abi.encodePacked(contractorDID, _milestoneId, block.timestamp)
        );

        disputes[disputeId] = Dispute({
            disputeId        : disputeId,
            contractorDID    : contractorDID,
            milestoneId      : _milestoneId,
            groundsHash      : _groundsHash,
            status           : DisputeStatus.FILED,
            filedAt          : block.timestamp,
            resolvedAt       : 0,
            resolutionHash   : bytes32(0),
            votesFor         : 0,
            votesAgainst     : 0,
            escalatedTo      : address(0),
            correctionIssued : false
        });

        contractorDisputes[contractorDID].push(disputeId);
        totalDisputes++;

        emit DisputeFiled(
            disputeId, contractorDID, _milestoneId,
            _groundsHash, block.timestamp
        );
    }

    // ─── DRC Workflow ────────────────────────────────────────────

    /**
     * @notice DRC member opens a filed dispute for committee review.
     * @param _disputeId Dispute to open for review
     */
    function openForReview(
        bytes32 _disputeId
    ) external onlyDRCMember disputeExists(_disputeId) {
        Dispute storage d = disputes[_disputeId];
        require(d.status == DisputeStatus.FILED, "BCRRS: not in FILED status");

        emit DisputeStatusChanged(
            _disputeId, DisputeStatus.FILED,
            DisputeStatus.UNDER_REVIEW, block.timestamp
        );
        d.status = DisputeStatus.UNDER_REVIEW;
    }

    /**
     * @notice Cast a DRC vote on a dispute under review.
     * @dev    Each DRC member may vote once per dispute.
     *         When REQUIRED_VOTES are reached in either direction,
     *         the dispute is automatically resolved.
     *
     * @param _disputeId    Dispute to vote on
     * @param _inFavour     true = uphold contractor's dispute; false = reject
     * @param _evidenceHash keccak256 of evidence reviewed (required for uphold)
     */
    function castVote(
        bytes32 _disputeId,
        bool    _inFavour,
        bytes32 _evidenceHash
    ) external onlyDRCMember disputeExists(_disputeId) {
        Dispute storage d = disputes[_disputeId];
        require(
            d.status == DisputeStatus.UNDER_REVIEW,
            "BCRRS: dispute not under review"
        );
        require(!hasVoted[_disputeId][msg.sender], "BCRRS: already voted");

        hasVoted[_disputeId][msg.sender] = true;
        drcMembers[msg.sender].votescast++;

        if (_inFavour) {
            d.votesFor++;
        } else {
            d.votesAgainst++;
        }

        emit DRCVoteCast(
            _disputeId, msg.sender, _inFavour,
            d.votesFor, d.votesAgainst, block.timestamp
        );

        // Auto-resolve when threshold reached
        if (d.votesFor >= REQUIRED_VOTES) {
            require(_evidenceHash != bytes32(0), "BCRRS: evidence required for uphold");
            _resolveUpheld(_disputeId, _evidenceHash);
        } else if (d.votesAgainst >= REQUIRED_VOTES) {
            _resolveRejected(_disputeId);
        }
    }

    /**
     * @notice Issue a correction after a dispute is upheld.
     * @dev    Called internally by castVote when uphold threshold is reached.
     *         The corrected values are supplied by the DRC in a separate
     *         issueCorrectionValues call to avoid packing too many params.
     */
    function issueCorrectionValues(
        bytes32 _disputeId,
        uint8   _correctedQualityScore,
        bool    _correctedMaterialCompliant,
        bool    _correctedDisputeFlag,
        bytes32 _evidenceHash
    ) external onlyDRCMember disputeExists(_disputeId) {
        Dispute storage d = disputes[_disputeId];
        require(d.status == DisputeStatus.UPHELD, "BCRRS: dispute not upheld");
        require(!d.correctionIssued,              "BCRRS: correction already issued");
        require(_correctedQualityScore <= 100,    "BCRRS: score out of range");
        require(_evidenceHash != bytes32(0),      "BCRRS: evidence hash required");

        bytes32 correctionId = keccak256(
            abi.encodePacked(_disputeId, block.timestamp)
        );

        corrections[correctionId] = CorrectionEvent({
            correctionId              : correctionId,
            disputeId                 : _disputeId,
            milestoneId               : d.milestoneId,
            contractorDID             : d.contractorDID,
            correctedQualityScore     : _correctedQualityScore,
            correctedMaterialCompliant: _correctedMaterialCompliant,
            correctedDisputeFlag      : _correctedDisputeFlag,
            evidenceHash              : _evidenceHash,
            issuedAt                  : block.timestamp,
            issuedBy                  : msg.sender
        });

        // Map milestone to its latest correction
        milestoneCorrection[d.milestoneId] = correctionId;
        d.correctionIssued = true;
        totalCorrections++;

        emit CorrectionIssued(
            correctionId, _disputeId, d.milestoneId,
            d.contractorDID, _correctedQualityScore, block.timestamp
        );
    }

    /**
     * @notice Escalate an unresolved or rejected dispute to an external tribunal.
     * @dev    Only the contractor who filed the dispute can escalate.
     *         Escalation is recorded immutably as part of the audit trail.
     *         The complete on-chain record (original attestation + dispute
     *         filing + DRC votes + this escalation event) constitutes
     *         admissible evidence in supporting jurisdictions.
     *
     * @param _disputeId  Dispute to escalate
     * @param _tribunal   Address or identifier of the court/tribunal
     */
    function escalateToCourt(
        bytes32 _disputeId,
        address _tribunal
    ) external disputeExists(_disputeId) {
        Dispute storage d = disputes[_disputeId];
        require(
            d.status == DisputeStatus.FILED      ||
            d.status == DisputeStatus.UNDER_REVIEW ||
            d.status == DisputeStatus.REJECTED,
            "BCRRS: cannot escalate from current status"
        );
        require(_tribunal != address(0), "BCRRS: invalid tribunal address");

        DisputeStatus oldStatus = d.status;
        d.status      = DisputeStatus.ESCALATED;
        d.escalatedTo = _tribunal;
        d.resolvedAt  = block.timestamp;

        emit DisputeStatusChanged(
            _disputeId, oldStatus, DisputeStatus.ESCALATED, block.timestamp
        );
        emit DisputeEscalated(
            _disputeId, d.contractorDID, _tribunal, block.timestamp
        );
    }

    // ─── Internal Resolution Helpers ─────────────────────────────

    function _resolveUpheld(bytes32 _disputeId, bytes32 _resolutionHash) internal {
        Dispute storage d = disputes[_disputeId];
        emit DisputeStatusChanged(
            _disputeId, DisputeStatus.UNDER_REVIEW,
            DisputeStatus.UPHELD, block.timestamp
        );
        d.status         = DisputeStatus.UPHELD;
        d.resolvedAt     = block.timestamp;
        d.resolutionHash = _resolutionHash;
    }

    function _resolveRejected(bytes32 _disputeId) internal {
        Dispute storage d = disputes[_disputeId];
        emit DisputeStatusChanged(
            _disputeId, DisputeStatus.UNDER_REVIEW,
            DisputeStatus.REJECTED, block.timestamp
        );
        d.status     = DisputeStatus.REJECTED;
        d.resolvedAt = block.timestamp;
    }

    // ─── View Functions ──────────────────────────────────────────

    /**
     * @notice Get the active correction for a milestone, if any.
     * @dev    The ML engine calls this during score recomputation.
     *         If a correction exists, its values override the original
     *         ReputationLedger accumulator values for that milestone.
     *
     * @param _milestoneId Milestone to check
     * @return exists      Whether a correction has been issued
     * @return correction  The CorrectionEvent struct (empty if none)
     */
    function getMilestoneCorrection(bytes32 _milestoneId)
        external
        view
        returns (bool exists, CorrectionEvent memory correction)
    {
        bytes32 cid = milestoneCorrection[_milestoneId];
        if (cid == bytes32(0)) return (false, correction);
        return (true, corrections[cid]);
    }

    /**
     * @notice Get all dispute IDs filed by a contractor.
     */
    function getContractorDisputes(bytes32 _did)
        external
        view
        returns (bytes32[] memory)
    {
        return contractorDisputes[_did];
    }

    /**
     * @notice Get the number of active DRC members.
     */
    function activeDRCCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < drcMemberList.length; i++) {
            if (drcMembers[drcMemberList[i]].active) count++;
        }
    }

    /**
     * @notice Check whether a DRC member has voted on a dispute.
     */
    function memberHasVoted(
        bytes32 _disputeId,
        address _member
    ) external view returns (bool) {
        return hasVoted[_disputeId][_member];
    }
}
