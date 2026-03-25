// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  ContractorRegistry
 * @notice Manages contractor onboarding, identity, and deactivation
 *         for the Blockchain-based Contractor Reputation and Ranking
 *         System (BCRRS).
 *
 * @dev    Only the designated `authority` address (a regulatory body
 *         or consortium of project owners) can deactivate contractors.
 *         Any wallet may self-register, but must supply verifiable
 *         license and bonding document hashes.
 *
 * Paper:  "A Blockchain-Based Dynamic Contractor Reputation and
 *          Ranking System with Machine Learning for Transparent
 *          Construction Procurement"
 *         Mujahid Ullah Khan Afridi, NMSU Industrial Engineering
 *
 * Repo:   https://github.com/[yourusername]/BCRRS
 */
contract ContractorRegistry {

    // ─── Enumerations ────────────────────────────────────────────

    /**
     * @dev Primary specialization category of the contractor.
     *      A contractor registers one primary and up to two secondary
     *      categories (tracked off-chain in the DApp layer).
     */
    enum Category {
        RESIDENTIAL,      // Single/multi-family, housing schemes
        COMMERCIAL,       // Offices, retail, hospitality
        INFRASTRUCTURE,   // Roads, bridges, dams, tunnels, ports
        INDUSTRIAL        // Factories, power plants, processing
    }

    // ─── Structs ─────────────────────────────────────────────────

    /**
     * @dev On-chain identity record for a registered contractor.
     */
    struct Contractor {
        bytes32  did;             // Decentralized Identifier (keccak256)
        address  wallet;          // Ethereum wallet address
        string   name;            // Legal registered name
        Category category;        // Primary specialization
        string   geographicTier;  // ISO 3166-2 code e.g. "US-NM", "PK-PB"
        bytes32  licenseHash;     // keccak256 of government license doc
        bytes32  bondingHash;     // keccak256 of bonding certificate
        bool     active;          // False if deactivated by authority
        uint256  registeredAt;    // Block timestamp of registration
    }

    // ─── State ───────────────────────────────────────────────────

    /// @notice Maps wallet address to contractor record
    mapping(address => Contractor) public contractors;

    /// @notice Reverse lookup: DID → wallet address
    mapping(bytes32 => address) public didToAddress;

    /// @notice License hash → DID (prevents Sybil re-registration)
    mapping(bytes32 => bytes32) public licenseHashToDID;

    /// @notice Regulatory authority that can approve/deactivate
    address public authority;

    /// @notice Total number of registered contractors
    uint256 public totalContractors;

    // ─── Events ──────────────────────────────────────────────────

    event ContractorRegistered(
        bytes32 indexed did,
        address indexed wallet,
        Category        category,
        string          geographicTier,
        uint256         timestamp
    );

    event ContractorDeactivated(
        bytes32 indexed did,
        address indexed wallet,
        string          reason,
        uint256         timestamp
    );

    event ContractorReactivated(
        bytes32 indexed did,
        address indexed wallet,
        uint256         timestamp
    );

    event AuthorityTransferred(
        address indexed oldAuthority,
        address indexed newAuthority
    );

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyAuthority() {
        require(msg.sender == authority, "BCRRS: caller is not authority");
        _;
    }

    modifier onlyActive(address _contractor) {
        require(contractors[_contractor].active, "BCRRS: contractor not active");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    /**
     * @param _authority Address of the regulatory body that governs
     *                   contractor deactivation (e.g. PPRA, FPCCI).
     */
    constructor(address _authority) {
        require(_authority != address(0), "BCRRS: zero authority address");
        authority = _authority;
    }

    // ─── External Functions ──────────────────────────────────────

    /**
     * @notice Register a new contractor on BCRRS.
     * @dev    Each wallet may register only once. Each license hash
     *         maps to exactly one DID — prevents Sybil re-registration
     *         under a new wallet (AV-4 mitigation).
     *
     * @param _name         Legal registered name of the contractor
     * @param _category     Primary specialization category
     * @param _tier         ISO 3166-2 geographic tier code
     * @param _licenseHash  keccak256 of government-issued license document
     * @param _bondingHash  keccak256 of bonding/surety certificate
     */
    function register(
        string   calldata _name,
        Category          _category,
        string   calldata _tier,
        bytes32           _licenseHash,
        bytes32           _bondingHash
    ) external {
        require(
            !contractors[msg.sender].active,
            "BCRRS: wallet already registered"
        );
        require(
            licenseHashToDID[_licenseHash] == bytes32(0),
            "BCRRS: license already registered (Sybil prevention)"
        );
        require(bytes(_name).length > 0,  "BCRRS: name cannot be empty");
        require(bytes(_tier).length > 0,  "BCRRS: tier cannot be empty");
        require(_licenseHash != bytes32(0), "BCRRS: invalid license hash");
        require(_bondingHash  != bytes32(0), "BCRRS: invalid bonding hash");

        bytes32 did = keccak256(
            abi.encodePacked(msg.sender, _licenseHash, block.timestamp)
        );

        contractors[msg.sender] = Contractor({
            did           : did,
            wallet        : msg.sender,
            name          : _name,
            category      : _category,
            geographicTier: _tier,
            licenseHash   : _licenseHash,
            bondingHash   : _bondingHash,
            active        : true,
            registeredAt  : block.timestamp
        });

        didToAddress[did]              = msg.sender;
        licenseHashToDID[_licenseHash] = did;
        totalContractors++;

        emit ContractorRegistered(
            did, msg.sender, _category, _tier, block.timestamp
        );
    }

    /**
     * @notice Deactivate a contractor (suspension or permanent ban).
     * @dev    Callable only by authority. Records reason on-chain for
     *         public auditability (anti-nepotism measure).
     *
     * @param _contractor  Wallet address of contractor to deactivate
     * @param _reason      Human-readable reason (logged in event)
     */
    function deactivate(
        address          _contractor,
        string calldata  _reason
    ) external onlyAuthority onlyActive(_contractor) {
        contractors[_contractor].active = false;

        emit ContractorDeactivated(
            contractors[_contractor].did,
            _contractor,
            _reason,
            block.timestamp
        );
    }

    /**
     * @notice Reactivate a previously deactivated contractor.
     * @param _contractor  Wallet address of contractor to reactivate
     */
    function reactivate(
        address _contractor
    ) external onlyAuthority {
        require(
            !contractors[_contractor].active,
            "BCRRS: contractor already active"
        );
        require(
            contractors[_contractor].registeredAt > 0,
            "BCRRS: contractor not registered"
        );
        contractors[_contractor].active = true;

        emit ContractorReactivated(
            contractors[_contractor].did,
            _contractor,
            block.timestamp
        );
    }

    /**
     * @notice Transfer authority role to a new address.
     * @param _newAuthority New regulatory authority address
     */
    function transferAuthority(
        address _newAuthority
    ) external onlyAuthority {
        require(_newAuthority != address(0), "BCRRS: zero address");
        emit AuthorityTransferred(authority, _newAuthority);
        authority = _newAuthority;
    }

    // ─── View Functions ──────────────────────────────────────────

    /**
     * @notice Check whether a wallet address is a registered
     *         and active contractor.
     */
    function isActive(address _contractor) external view returns (bool) {
        return contractors[_contractor].active;
    }

    /**
     * @notice Get contractor DID by wallet address.
     */
    function getDID(address _contractor) external view returns (bytes32) {
        return contractors[_contractor].did;
    }

    /**
     * @notice Get full contractor record by wallet address.
     */
    function getContractor(
        address _contractor
    ) external view returns (Contractor memory) {
        return contractors[_contractor];
    }
}
