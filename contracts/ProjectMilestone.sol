// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ContractorRegistry.sol";
import "./ReputationLedger.sol";

/**
 * @title  ProjectMilestone
 * @notice Records verifiable project milestone performance events
 *         for BCRRS. Each milestone is attested by a certified
 *         independent inspector — the core trust mechanism that
 *         prevents contractor self-reporting fraud.
 *
 * @dev    Key design decisions:
 *         1. Inspector is assigned per-project by the owner, but
 *            must be pre-registered in the inspectors mapping by
 *            the authority — eliminating collusion (AV-2 mitigation).
 *         2. Once a milestone is completed, it cannot be altered.
 *         3. Material compliance is attested by the inspector via
 *            hash commitment of compliance documents (AV-3 mitigation).
 *         4. Anti-nepotism: pre-selection snapshot is recorded before
 *            award decision is made (Section VIII of the paper).
 *
 * Paper:  "A Blockchain-Based Dynamic Contractor Reputation and
 *          Ranking System with Machine Learning for Transparent
 *          Construction Procurement"
 *         Mujahid Ullah Khan Afridi, NMSU Industrial Engineering
 */
contract ProjectMilestone {

    // ─── Structs ─────────────────────────────────────────────────

    /**
     * @dev A single project milestone record.
     */
    struct Milestone {
        bytes32  contractorDID;     // DID of executing contractor
        bytes32  projectId;         // Parent project identifier
        string   description;       // Human-readable milestone scope
        uint256  plannedDate;       // Agreed completion timestamp
        uint256  actualDate;        // Actual completion (set on completion)
        uint8    qualityScore;      // Inspector score [0-100]
        bytes32  materialHash;      // keccak256 of material compliance docs
        bool     materialCompliant; // Inspector attestation of spec compliance
        bool     disputeRaised;     // Whether a dispute was filed
        address  inspector;         // Inspector who attested completion
        bool     completed;         // Completion flag (immutable once true)
        uint256  createdAt;         // Creation timestamp
    }

    /**
     * @dev A registered project with its inspector and bid snapshot.
     */
    struct Project {
        bytes32  projectId;
        address  owner;             // Project owner address
        bytes32  contractorDID;     // Awarded contractor DID
        address  inspector;         // Assigned certified inspector
        string   specialization;    // Category string for off-chain indexing
        string   geographicTier;    // ISO 3166-2 tier
        uint256  contractValue;     // Contract value in USD (for complexity weight)
        bool     active;
        uint256  createdAt;
        // Anti-nepotism: snapshot of top-3 bidders at time of bid invitation
        bytes32[3] bidSnapshotDIDs;
        uint256[3] bidSnapshotScores; // Scores in basis points at bid time
    }

    // ─── State ───────────────────────────────────────────────────

    /// @notice milestoneId => Milestone record
    mapping(bytes32 => Milestone) public milestones;

    /// @notice projectId => Project record
    mapping(bytes32 => Project) public projects;

    /// @notice Certified inspectors registered by authority
    mapping(address => bool) public certifiedInspectors;

    /// @notice projectId => list of milestone IDs
    mapping(bytes32 => bytes32[]) public projectMilestones;

    /// @notice References to sibling contracts
    ContractorRegistry public registry;
    ReputationLedger   public ledger;
    address            public authority;

    uint256 public totalMilestones;
    uint256 public totalProjects;

    // ─── Events ──────────────────────────────────────────────────

    event ProjectRegistered(
        bytes32 indexed projectId,
        address indexed owner,
        bytes32 indexed contractorDID,
        uint256         contractValue,
        uint256         timestamp
    );

    event InspectorCertified(
        address indexed inspector,
        uint256         timestamp
    );

    event InspectorRevoked(
        address indexed inspector,
        string          reason,
        uint256         timestamp
    );

    event InspectorAssigned(
        bytes32 indexed projectId,
        address indexed inspector,
        uint256         timestamp
    );

    event MilestoneCreated(
        bytes32 indexed milestoneId,
        bytes32 indexed projectId,
        bytes32 indexed contractorDID,
        uint256         plannedDate,
        uint256         timestamp
    );

    event MilestoneCompleted(
        bytes32 indexed milestoneId,
        bytes32 indexed contractorDID,
        uint8           qualityScore,
        bool            materialCompliant,
        bool            disputeRaised,
        uint256         delaySeconds,
        uint256         timestamp
    );

    event BidSnapshotRecorded(
        bytes32 indexed projectId,
        bytes32[3]      bidderDIDs,
        uint256[3]      scores,
        uint256         timestamp
    );

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyAuthority() {
        require(msg.sender == authority, "BCRRS: not authority");
        _;
    }

    modifier onlyCertifiedInspector(bytes32 _projectId) {
        require(
            msg.sender == projects[_projectId].inspector,
            "BCRRS: not assigned inspector"
        );
        require(
            certifiedInspectors[msg.sender],
            "BCRRS: inspector not certified"
        );
        _;
    }

    modifier onlyProjectOwner(bytes32 _projectId) {
        require(
            msg.sender == projects[_projectId].owner,
            "BCRRS: not project owner"
        );
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    /**
     * @param _authority  Governance authority address
     * @param _registry   Deployed ContractorRegistry address
     * @param _ledger     Deployed ReputationLedger address
     */
    constructor(
        address _authority,
        address _registry,
        address _ledger
    ) {
        require(_authority != address(0), "BCRRS: zero authority");
        require(_registry  != address(0), "BCRRS: zero registry");
        require(_ledger    != address(0), "BCRRS: zero ledger");
        authority = _authority;
        registry  = ContractorRegistry(_registry);
        ledger    = ReputationLedger(_ledger);
    }

    // ─── Inspector Management (Authority) ────────────────────────

    /**
     * @notice Certify an independent inspector.
     * @dev    Inspectors are certified by the authority independently
     *         of any contractor or project owner — AV-2 mitigation.
     */
    function certifyInspector(address _inspector) external onlyAuthority {
        require(_inspector != address(0), "BCRRS: zero address");
        certifiedInspectors[_inspector] = true;
        emit InspectorCertified(_inspector, block.timestamp);
    }

    /**
     * @notice Revoke an inspector's certification.
     */
    function revokeInspector(
        address         _inspector,
        string calldata _reason
    ) external onlyAuthority {
        certifiedInspectors[_inspector] = false;
        emit InspectorRevoked(_inspector, _reason, block.timestamp);
    }

    // ─── Project Management ──────────────────────────────────────

    /**
     * @notice Register a new construction project on BCRRS.
     * @dev    Records the anti-nepotism bid snapshot at the time of
     *         award — top 3 bidder DIDs and their scores are committed
     *         immutably before the award decision takes effect.
     *
     * @param _projectId       Unique project identifier
     * @param _contractorDID   DID of awarded contractor
     * @param _specialization  Specialization category string
     * @param _tier            Geographic tier code
     * @param _contractValue   Contract value in USD
     * @param _bidDIDs         Top-3 bidder DIDs at bid time (anti-nepotism)
     * @param _bidScores       Top-3 bidder BCRRS scores at bid time (bps)
     */
    function registerProject(
        bytes32          _projectId,
        bytes32          _contractorDID,
        string  calldata _specialization,
        string  calldata _tier,
        uint256          _contractValue,
        bytes32[3] calldata _bidDIDs,
        uint256[3] calldata _bidScores
    ) external {
        require(_projectId     != bytes32(0), "BCRRS: invalid project ID");
        require(_contractorDID != bytes32(0), "BCRRS: invalid contractor DID");
        require(
            projects[_projectId].createdAt == 0,
            "BCRRS: project already registered"
        );

        // Verify awarded contractor is active in registry
        address contractorWallet = registry.didToAddress(_contractorDID);
        require(
            registry.isActive(contractorWallet),
            "BCRRS: contractor not active"
        );

        projects[_projectId] = Project({
            projectId       : _projectId,
            owner           : msg.sender,
            contractorDID   : _contractorDID,
            inspector       : address(0),
            specialization  : _specialization,
            geographicTier  : _tier,
            contractValue   : _contractValue,
            active          : true,
            createdAt       : block.timestamp,
            bidSnapshotDIDs : _bidDIDs,
            bidSnapshotScores: _bidScores
        });

        totalProjects++;

        emit ProjectRegistered(
            _projectId, msg.sender, _contractorDID,
            _contractValue, block.timestamp
        );

        emit BidSnapshotRecorded(
            _projectId, _bidDIDs, _bidScores, block.timestamp
        );
    }

    /**
     * @notice Assign a certified inspector to a project.
     * @dev    Only project owner may assign. Inspector must be
     *         pre-certified by authority.
     */
    function assignInspector(
        bytes32 _projectId,
        address _inspector
    ) external onlyProjectOwner(_projectId) {
        require(
            certifiedInspectors[_inspector],
            "BCRRS: inspector not certified by authority"
        );
        projects[_projectId].inspector = _inspector;
        emit InspectorAssigned(_projectId, _inspector, block.timestamp);
    }

    // ─── Milestone Management ────────────────────────────────────

    /**
     * @notice Create a new milestone for a project.
     * @dev    Called by project owner to define scope and planned date.
     *
     * @param _milestoneId   Unique milestone identifier
     * @param _projectId     Parent project ID
     * @param _description   Scope description
     * @param _plannedDate   Agreed completion timestamp
     */
    function createMilestone(
        bytes32         _milestoneId,
        bytes32         _projectId,
        string calldata _description,
        uint256         _plannedDate
    ) external onlyProjectOwner(_projectId) {
        require(_milestoneId != bytes32(0), "BCRRS: invalid milestone ID");
        require(_plannedDate > block.timestamp, "BCRRS: planned date in past");
        require(
            milestones[_milestoneId].createdAt == 0,
            "BCRRS: milestone already exists"
        );
        require(
            projects[_projectId].inspector != address(0),
            "BCRRS: assign inspector before creating milestones"
        );

        bytes32 contractorDID = projects[_projectId].contractorDID;

        milestones[_milestoneId] = Milestone({
            contractorDID   : contractorDID,
            projectId       : _projectId,
            description     : _description,
            plannedDate     : _plannedDate,
            actualDate      : 0,
            qualityScore    : 0,
            materialHash    : bytes32(0),
            materialCompliant: false,
            disputeRaised   : false,
            inspector       : address(0),
            completed       : false,
            createdAt       : block.timestamp
        });

        projectMilestones[_projectId].push(_milestoneId);
        totalMilestones++;

        emit MilestoneCreated(
            _milestoneId, _projectId, contractorDID,
            _plannedDate, block.timestamp
        );
    }

    /**
     * @notice Attest completion of a milestone.
     * @dev    Only the assigned certified inspector may call this.
     *         Once called, the milestone record is immutable.
     *         Automatically pushes data to ReputationLedger.
     *
     * @param _milestoneId      Milestone to complete
     * @param _qualityScore     Inspector quality assessment [0-100]
     * @param _materialHash     keccak256 of material compliance documents
     * @param _materialCompliant Whether materials matched specification
     * @param _disputeRaised    Whether a dispute was raised during this milestone
     */
    function completeMilestone(
        bytes32 _milestoneId,
        uint8   _qualityScore,
        bytes32 _materialHash,
        bool    _materialCompliant,
        bool    _disputeRaised
    ) external onlyCertifiedInspector(milestones[_milestoneId].projectId) {
        Milestone storage ms = milestones[_milestoneId];

        require(!ms.completed,        "BCRRS: milestone already completed");
        require(_qualityScore <= 100, "BCRRS: score out of range");
        require(_materialHash != bytes32(0), "BCRRS: material hash required");

        ms.actualDate        = block.timestamp;
        ms.qualityScore      = _qualityScore;
        ms.materialHash      = _materialHash;
        ms.materialCompliant = _materialCompliant;
        ms.disputeRaised     = _disputeRaised;
        ms.inspector         = msg.sender;
        ms.completed         = true;

        uint256 delaySeconds = ms.actualDate > ms.plannedDate
            ? ms.actualDate - ms.plannedDate
            : 0;

        emit MilestoneCompleted(
            _milestoneId,
            ms.contractorDID,
            _qualityScore,
            _materialCompliant,
            _disputeRaised,
            delaySeconds,
            block.timestamp
        );

        // Push to ReputationLedger — triggers reputation update
        ledger.recordMilestone(
            ms.contractorDID,
            ms.plannedDate,
            ms.actualDate,
            _qualityScore,
            _materialCompliant,
            _disputeRaised
        );
    }

    // ─── View Functions ──────────────────────────────────────────

    /**
     * @notice Get all milestone IDs for a project.
     */
    function getProjectMilestones(
        bytes32 _projectId
    ) external view returns (bytes32[] memory) {
        return projectMilestones[_projectId];
    }

    /**
     * @notice Get full milestone record.
     */
    function getMilestone(
        bytes32 _milestoneId
    ) external view returns (Milestone memory) {
        return milestones[_milestoneId];
    }

    /**
     * @notice Get bid snapshot for anti-nepotism audit.
     */
    function getBidSnapshot(
        bytes32 _projectId
    ) external view returns (bytes32[3] memory dids, uint256[3] memory scores) {
        Project storage p = projects[_projectId];
        return (p.bidSnapshotDIDs, p.bidSnapshotScores);
    }

    /**
     * @notice Check if an address is a certified inspector.
     */
    function isCertifiedInspector(
        address _inspector
    ) external view returns (bool) {
        return certifiedInspectors[_inspector];
    }
}
