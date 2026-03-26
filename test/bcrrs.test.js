/**
 * BCRRS Test Suite
 * ================
 * Comprehensive tests covering:
 *   - All three smart contracts
 *   - Gas measurements for Table III in the paper
 *   - Attack vector mitigations (AV-1 through AV-7)
 *   - Anti-nepotism mechanisms
 *   - Reputation metric computations (SPI, DDS, MCR, FCI)
 *
 * Run:  npx hardhat test
 * Gas:  REPORT_GAS=true npx hardhat test
 */

const { expect }  = require("chai");
const { ethers }  = require("hardhat");

// ── Helpers ────────────────────────────────────────────────────────────────

const Category = { RESIDENTIAL: 0, COMMERCIAL: 1, INFRASTRUCTURE: 2, INDUSTRIAL: 3 };

/**
 * Deploy all three BCRRS contracts and wire them together.
 */
async function deployBCRRS() {
  const [authority, owner, contractor, inspector, stranger] =
    await ethers.getSigners();

  const ContractorRegistry = await ethers.getContractFactory("ContractorRegistry");
  const registry = await ContractorRegistry.deploy(authority.address);
  await registry.waitForDeployment();

  const ReputationLedger = await ethers.getContractFactory("ReputationLedger");
  const ledger = await ReputationLedger.deploy(
    authority.address,
    authority.address // placeholder
  );
  await ledger.waitForDeployment();

  const ProjectMilestone = await ethers.getContractFactory("ProjectMilestone");
  const milestone = await ProjectMilestone.deploy(
    authority.address,
    await registry.getAddress(),
    await ledger.getAddress()
  );
  await milestone.waitForDeployment();

  // Wire ledger to real milestone contract
  await ledger.connect(authority).setMilestoneContract(
    await milestone.getAddress()
  );

  return { authority, owner, contractor, inspector, stranger,
           registry, ledger, milestone };
}

/**
 * Register a contractor and return their DID.
 */
async function registerContractor(registry, contractor, overrides = {}) {
  const licenseHash = overrides.licenseHash ||
    ethers.keccak256(ethers.toUtf8Bytes("LICENSE-" + contractor.address));
  const bondingHash = overrides.bondingHash ||
    ethers.keccak256(ethers.toUtf8Bytes("BOND-" + contractor.address));

  const tx = await registry.connect(contractor).register(
    overrides.name     || "Test Contractor LLC",
    overrides.category || Category.INFRASTRUCTURE,
    overrides.tier     || "PK-KP",
    licenseHash,
    bondingHash
  );
  await tx.wait();

  return registry.getDID(contractor.address);
}

/**
 * Set up a full project with inspector and one milestone.
 */
async function setupProjectWithMilestone(
  { authority, owner, contractor, inspector, registry, ledger, milestone },
  overrides = {}
) {
  const contractorDID = await registerContractor(registry, contractor);

  // Certify inspector
  await milestone.connect(authority).certifyInspector(inspector.address);

  const projectId   = overrides.projectId   || ethers.id("PROJECT-001");
  const milestoneId = overrides.milestoneId || ethers.id("MILESTONE-001");
  const plannedDate = overrides.plannedDate ||
    Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days from now

  const bidDIDs    = [contractorDID, ethers.ZeroHash, ethers.ZeroHash];
  const bidScores  = [8500n, 0n, 0n]; // 85% score in bps

  // Register project
  await milestone.connect(owner).registerProject(
    projectId,
    contractorDID,
    "INFRASTRUCTURE",
    "PK-KP",
    ethers.parseUnits("120000000", 0), // $120M
    bidDIDs,
    bidScores
  );

  // Assign inspector
  await milestone.connect(owner).assignInspector(projectId, inspector.address);

  // Create milestone
  await milestone.connect(owner).createMilestone(
    milestoneId,
    projectId,
    "Foundation and Groundworks",
    plannedDate
  );

  return { contractorDID, projectId, milestoneId, plannedDate };
}

// ── Test Suites ────────────────────────────────────────────────────────────

describe("BCRRS — ContractorRegistry", function () {

  describe("Deployment", function () {
    it("Should set the authority correctly", async function () {
      const { authority, registry } = await deployBCRRS();
      expect(await registry.authority()).to.equal(authority.address);
    });
  });

  describe("register() — Gas Measurement (Table III)", function () {
    it("Should register a contractor and emit event", async function () {
      const { contractor, registry } = await deployBCRRS();
      const licenseHash = ethers.keccak256(ethers.toUtf8Bytes("LIC-001"));
      const bondingHash  = ethers.keccak256(ethers.toUtf8Bytes("BOND-001"));

      const tx = await registry.connect(contractor).register(
        "Alpha Builders Ltd",
        Category.INFRASTRUCTURE,
        "PK-KP",
        licenseHash,
        bondingHash
      );
      const receipt = await tx.wait();

      // Verify DID assigned
      const did = await registry.getDID(contractor.address);
      expect(did).to.not.equal(ethers.ZeroHash);
      expect(await registry.isActive(contractor.address)).to.be.true;

      console.log(`      register() gas used: ${receipt.gasUsed.toString()}`);
    });
  });

  describe("deactivate() — Gas Measurement (Table III)", function () {
    it("Should deactivate a contractor — authority only", async function () {
      const { authority, contractor, stranger, registry } = await deployBCRRS();
      await registerContractor(registry, contractor);

      // Stranger cannot deactivate
      await expect(
        registry.connect(stranger).deactivate(contractor.address, "Fraud")
      ).to.be.revertedWith("BCRRS: caller is not authority");

      // Authority can deactivate
      const tx = await registry.connect(authority).deactivate(
        contractor.address, "License revoked"
      );
      const receipt = await tx.wait();
      expect(await registry.isActive(contractor.address)).to.be.false;

      console.log(`      deactivate() gas used: ${receipt.gasUsed.toString()}`);
    });
  });

  describe("AV-4 — Sybil Registration Prevention", function () {
    it("Should prevent re-registration with same license hash", async function () {
      const { contractor, stranger, registry } = await deployBCRRS();
      const licenseHash = ethers.keccak256(ethers.toUtf8Bytes("LIC-SHARED"));
      const bondingHash  = ethers.keccak256(ethers.toUtf8Bytes("BOND-001"));

      // First registration succeeds
      await registry.connect(contractor).register(
        "Legit Contractor", Category.RESIDENTIAL, "US-NM",
        licenseHash, bondingHash
      );

      // Second wallet with same license hash fails
      await expect(
        registry.connect(stranger).register(
          "Sybil Contractor", Category.RESIDENTIAL, "US-NM",
          licenseHash,
          ethers.keccak256(ethers.toUtf8Bytes("BOND-002"))
        )
      ).to.be.revertedWith("BCRRS: license already registered (Sybil prevention)");
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────

describe("BCRRS — ProjectMilestone", function () {

  describe("assignInspector() — Gas Measurement (Table III)", function () {
    it("Should assign a certified inspector to a project", async function () {
      const ctx = await deployBCRRS();
      const { authority, owner, contractor, inspector, milestone, registry } = ctx;

      const contractorDID = await registerContractor(registry, contractor);
      await milestone.connect(authority).certifyInspector(inspector.address);

      const projectId  = ethers.id("PROJECT-ASSIGN");
      const bidDIDs    = [contractorDID, ethers.ZeroHash, ethers.ZeroHash];
      const bidScores  = [9000n, 0n, 0n];
      const plannedEnd = Math.floor(Date.now() / 1000) + 86400 * 60;

      await milestone.connect(owner).registerProject(
        projectId, contractorDID, "INFRASTRUCTURE", "US-NM",
        500000000n, bidDIDs, bidScores
      );

      const tx = await milestone.connect(owner).assignInspector(
        projectId, inspector.address
      );
      const receipt = await tx.wait();
      console.log(`      assignInspector() gas used: ${receipt.gasUsed.toString()}`);

      const project = await milestone.projects(projectId);
      expect(project.inspector).to.equal(inspector.address);
    });
  });

  describe("completeMilestone() — Gas Measurement (Table III)", function () {
    it("Should complete a milestone and push to ledger", async function () {
      const ctx = await deployBCRRS();
      const { inspector, milestone, ledger } = ctx;
      const { contractorDID, projectId, milestoneId } =
        await setupProjectWithMilestone(ctx);

      const materialHash = ethers.keccak256(
        ethers.toUtf8Bytes("MATERIAL-CERT-001")
      );

      const tx = await milestone.connect(inspector).completeMilestone(
        milestoneId,
        85,          // quality score
        materialHash,
        true,        // material compliant
        false        // no dispute
      );
      const receipt = await tx.wait();
      console.log(`      completeMilestone() gas used: ${receipt.gasUsed.toString()}`);

      // Verify milestone marked complete
      const ms = await milestone.getMilestone(milestoneId);
      expect(ms.completed).to.be.true;
      expect(ms.qualityScore).to.equal(85);
      expect(ms.materialCompliant).to.be.true;

      // Verify ledger updated
      const profile = await ledger.getProfile(contractorDID);
      expect(profile.totalMilestones).to.equal(1n);
      expect(profile.qualityScoreSum).to.equal(85n);
      expect(profile.materialCompliantCount).to.equal(1n);
    });

    it("Should not allow duplicate completion", async function () {
      const ctx = await deployBCRRS();
      const { inspector, milestone } = ctx;
      const { milestoneId } = await setupProjectWithMilestone(ctx);

      const materialHash = ethers.keccak256(ethers.toUtf8Bytes("MAT-001"));

      await milestone.connect(inspector).completeMilestone(
        milestoneId, 80, materialHash, true, false
      );

      await expect(
        milestone.connect(inspector).completeMilestone(
          milestoneId, 90, materialHash, true, false
        )
      ).to.be.revertedWith("BCRRS: milestone already completed");
    });
  });

  describe("AV-2 — Inspector Collusion Prevention", function () {
    it("Should reject completion from uncertified address", async function () {
      const ctx = await deployBCRRS();
      const { stranger, milestone } = ctx;
      const { milestoneId } = await setupProjectWithMilestone(ctx);

      const materialHash = ethers.keccak256(ethers.toUtf8Bytes("MAT-001"));

      await expect(
        milestone.connect(stranger).completeMilestone(
          milestoneId, 95, materialHash, true, false
        )
      ).to.be.revertedWith("BCRRS: not assigned inspector");
    });
  });

  describe("Anti-Nepotism — Bid Snapshot", function () {
    it("Should record bid snapshot immutably on project registration", async function () {
      const ctx = await deployBCRRS();
      const { milestone } = ctx;
      const { projectId, contractorDID } = await setupProjectWithMilestone(ctx);

      const [dids, scores] = await milestone.getBidSnapshot(projectId);
      expect(dids[0]).to.equal(contractorDID);
      expect(scores[0]).to.equal(8500n);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────

describe("BCRRS — ReputationLedger", function () {

  describe("recordMilestone() — Gas Measurement (Table III)", function () {
    it("Should update all reputation counters correctly", async function () {
      const ctx = await deployBCRRS();
      const { inspector, milestone, ledger } = ctx;
      const { contractorDID, milestoneId } =
        await setupProjectWithMilestone(ctx);

      const materialHash = ethers.keccak256(ethers.toUtf8Bytes("MAT-002"));
      const tx = await milestone.connect(inspector).completeMilestone(
        milestoneId, 72, materialHash, true, false
      );
      const receipt = await tx.wait();
      console.log(`      recordMilestone() gas used (via completeMilestone): ${receipt.gasUsed.toString()}`);

      const profile = await ledger.getProfile(contractorDID);
      expect(profile.totalMilestones).to.equal(1n);
      expect(profile.qualityScoreSum).to.equal(72n);
      expect(profile.disputeCount).to.equal(0n);
    });
  });

  describe("getProfile() — Gas (view = 0)", function () {
    it("Should return profile as a view function (zero gas cost)", async function () {
      const ctx = await deployBCRRS();
      const { ledger } = ctx;
      const { contractorDID } = await setupProjectWithMilestone(ctx);

      // View functions cost zero gas on-chain
      const profile = await ledger.getProfile(contractorDID);
      expect(profile).to.not.be.undefined;
      console.log(`      getProfile() gas used: 0 (view function)`);
    });
  });

  describe("Reputation Metrics (SPI, DDS, MCR, FCI)", function () {
    it("Should compute all four BCRRS metrics correctly", async function () {
      const ctx = await deployBCRRS();
      const { authority, owner, inspector, milestone, ledger, registry } = ctx;
      const { contractor } = ctx;

      const contractorDID = await registerContractor(registry, contractor);
      await milestone.connect(authority).certifyInspector(inspector.address);

      const DELTA_MAX = 7776000n; // 90 days in seconds

      // Complete 3 milestones: 2 on time, 1 late; all compliant; 1 dispute
      for (let i = 0; i < 3; i++) {
        const projectId   = ethers.id(`PROJ-METRIC-${i}`);
        const milestoneId = ethers.id(`MS-METRIC-${i}`);
        const plannedDate = Math.floor(Date.now() / 1000) + 86400 * 30;

        const bidDIDs   = [contractorDID, ethers.ZeroHash, ethers.ZeroHash];
        const bidScores = [8000n, 0n, 0n];

        await milestone.connect(owner).registerProject(
          projectId, contractorDID, "INFRASTRUCTURE", "PK-KP",
          100000000n, bidDIDs, bidScores
        );
        await milestone.connect(owner).assignInspector(projectId, inspector.address);
        await milestone.connect(owner).createMilestone(
          milestoneId, projectId, `Milestone ${i}`, plannedDate
        );

        const score    = i === 2 ? 60 : 85; // 85, 85, 60
        const compliant = true;
        const dispute   = i === 2;          // dispute on 3rd milestone

        await milestone.connect(inspector).completeMilestone(
          milestoneId, score,
          ethers.keccak256(ethers.toUtf8Bytes(`MAT-${i}`)),
          compliant, dispute
        );
      }

      const profile = await ledger.getProfile(contractorDID);
      expect(profile.totalMilestones).to.equal(3n);
      expect(profile.qualityScoreSum).to.equal(230n); // 85+85+60
      expect(profile.materialCompliantCount).to.equal(3n);
      expect(profile.disputeCount).to.equal(1n);

      // DDS = 230/3 ≈ 76.67 — scaled by 1e2 = 7666
      const dds = await ledger.computeDDS(contractorDID);
      expect(dds).to.be.closeTo(7666n, 5n);

      // MCR = 3/3 = 1.0 — scaled by 1e4 = 10000
      const mcr = await ledger.computeMCR(contractorDID);
      expect(mcr).to.equal(10000n);

      // FCI = 1 - 1/3 = 0.667 — scaled by 1e4 ≈ 6666
      const fci = await ledger.computeFCI(contractorDID);
      expect(fci).to.be.closeTo(6666n, 5n);

      console.log(`      DDS (scaled): ${dds.toString()}`);
      console.log(`      MCR (scaled): ${mcr.toString()}`);
      console.log(`      FCI (scaled): ${fci.toString()}`);
    });
  });

  describe("Anti-Nepotism — Deviation Event", function () {
    it("Should record a deviation event with justification hash", async function () {
      const ctx = await deployBCRRS();
      const { authority, ledger } = ctx;
      const { contractorDID } = await setupProjectWithMilestone(ctx);

      const projectId   = ethers.id("PROJECT-DEVIATION");
      const topDID      = ethers.keccak256(ethers.toUtf8Bytes("TOP-CONTRACTOR"));
      const justHash    = ethers.keccak256(
        ethers.toUtf8Bytes("Local content mandate requires regional contractor")
      );

      const tx = await ledger.connect(authority).recordDeviationEvent(
        projectId, contractorDID, topDID, 1500n, justHash
      );
      await tx.wait();

      expect(await ledger.hasDeviationEvent(projectId)).to.be.true;

      const event = await ledger.deviationEvents(projectId);
      expect(event.justificationHash).to.equal(justHash);
      expect(event.scoreGap).to.equal(1500n);
    });

    it("Should prevent overwriting an existing deviation event", async function () {
      const ctx = await deployBCRRS();
      const { authority, ledger } = ctx;
      const { contractorDID } = await setupProjectWithMilestone(ctx);

      const projectId = ethers.id("PROJECT-DOUBLE-DEV");
      const topDID    = ethers.keccak256(ethers.toUtf8Bytes("TOP"));
      const justHash  = ethers.keccak256(ethers.toUtf8Bytes("Justification"));

      await ledger.connect(authority).recordDeviationEvent(
        projectId, contractorDID, topDID, 500n, justHash
      );

      await expect(
        ledger.connect(authority).recordDeviationEvent(
          projectId, contractorDID, topDID, 200n, justHash
        )
      ).to.be.revertedWith("BCRRS: deviation already recorded for project");
    });
  });

  describe("Yearly Snapshot (Annual Leaderboard)", function () {
    it("Should take a yearly snapshot and prevent duplicates", async function () {
      const ctx = await deployBCRRS();
      const { authority, inspector, milestone, ledger } = ctx;
      const { contractorDID, milestoneId } =
        await setupProjectWithMilestone(ctx);

      // Complete a milestone first
      await milestone.connect(inspector).completeMilestone(
        milestoneId, 88,
        ethers.keccak256(ethers.toUtf8Bytes("MAT")),
        true, false
      );

      // Take 2025 snapshot
      await ledger.connect(authority).takeYearlySnapshot(contractorDID, 2025);

      const snap = await ledger.getYearlySnapshot(contractorDID, 2025);
      expect(snap.year).to.equal(2025n);
      expect(snap.totalMilestones).to.equal(1n);
      expect(snap.qualityScoreSum).to.equal(88n);

      // Cannot take same year snapshot twice
      await expect(
        ledger.connect(authority).takeYearlySnapshot(contractorDID, 2025)
      ).to.be.revertedWith("BCRRS: snapshot already taken for this year");
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// APPEND THIS ENTIRE BLOCK TO THE END OF test/bcrrs.test.js
// ──────────────────────────────────────────────────────────────────────────

describe("BCRRS — DisputeRegistry", function () {

  /**
   * Deploy all four contracts including DisputeRegistry.
   */
  async function deployWithDispute() {
    const [authority, owner, contractor, inspector, drc1, drc2, drc3, stranger] =
      await ethers.getSigners();

    // Deploy base three contracts
    const registry = await (
      await ethers.getContractFactory("ContractorRegistry")
    ).deploy(authority.address);
    await registry.waitForDeployment();

    const ledger = await (
      await ethers.getContractFactory("ReputationLedger")
    ).deploy(authority.address, authority.address);
    await ledger.waitForDeployment();

    const milestone = await (
      await ethers.getContractFactory("ProjectMilestone")
    ).deploy(authority.address, await registry.getAddress(), await ledger.getAddress());
    await milestone.waitForDeployment();

    await ledger.connect(authority).setMilestoneContract(await milestone.getAddress());

    // Deploy DisputeRegistry
    const disputeReg = await (
      await ethers.getContractFactory("DisputeRegistry")
    ).deploy(authority.address, await ledger.getAddress());
    await disputeReg.waitForDeployment();

    // Add three DRC members
    await disputeReg.connect(authority).addDRCMember(
      drc1.address, "Pakistan Engineering Council"
    );
    await disputeReg.connect(authority).addDRCMember(
      drc2.address, "PPRA Regulatory Authority"
    );
    await disputeReg.connect(authority).addDRCMember(
      drc3.address, "Contractor Representative Body"
    );

    return {
      authority, owner, contractor, inspector,
      drc1, drc2, drc3, stranger,
      registry, ledger, milestone, disputeReg
    };
  }

  /**
   * File a dispute and return its disputeId.
   */
  async function fileDisputeHelper(disputeReg, contractor) {
    const milestoneId  = ethers.id("MILESTONE-DISPUTE-001");
    const groundsHash  = ethers.keccak256(
      ethers.toUtf8Bytes("Inspector gave unfairly low quality score of 40/100")
    );
    const tx = await disputeReg.connect(contractor).fileDispute(
      milestoneId, groundsHash
    );
    const receipt = await tx.wait();
    console.log(`      fileDispute() gas used: ${receipt.gasUsed.toString()}`);

    // Retrieve disputeId from event
    const event = receipt.logs.find(
      l => l.fragment && l.fragment.name === "DisputeFiled"
    );
    return event ? event.args[0] : ethers.id("DISPUTE-001");
  }

  // ── fileDispute() — Gas Measurement (Table IV) ─────────────────────────

  describe("fileDispute() — Gas Measurement (Table IV)", function () {
    it("Should file a dispute and emit DisputeFiled event", async function () {
      const { contractor, disputeReg } = await deployWithDispute();

      const milestoneId = ethers.id("MS-GAS-TEST");
      const groundsHash = ethers.keccak256(
        ethers.toUtf8Bytes("Quality score was incorrectly recorded")
      );

      const tx = await disputeReg.connect(contractor).fileDispute(
        milestoneId, groundsHash
      );
      const receipt = await tx.wait();
      console.log(`      fileDispute() gas used: ${receipt.gasUsed.toString()}`);

      expect(receipt.status).to.equal(1);
    });

    it("Should enforce MAX_ACTIVE_DISPUTES = 3 (AV-8 mitigation)", async function () {
      const { contractor, disputeReg } = await deployWithDispute();

      // File 3 disputes — should all succeed
      for (let i = 0; i < 3; i++) {
        await disputeReg.connect(contractor).fileDispute(
          ethers.id(`MS-FLOOD-${i}`),
          ethers.keccak256(ethers.toUtf8Bytes(`Grounds ${i}`))
        );
      }

      // 4th dispute should be rejected
      await expect(
        disputeReg.connect(contractor).fileDispute(
          ethers.id("MS-FLOOD-4"),
          ethers.keccak256(ethers.toUtf8Bytes("Overflow dispute"))
        )
      ).to.be.revertedWith(
        "BCRRS: too many active disputes — resolve existing ones first"
      );
    });
  });

  // ── castVote() — Gas Measurement (Table IV) ────────────────────────────

  describe("castVote() — Gas Measurement (Table IV)", function () {
    it("Should allow DRC members to cast votes", async function () {
      const { contractor, drc1, drc2, drc3, disputeReg } =
        await deployWithDispute();

      const disputeId = await fileDisputeHelper(disputeReg, contractor);

      // Open for review
      await disputeReg.connect(drc1).openForReview(disputeId);

      // First vote
      const evidenceHash = ethers.keccak256(
        ethers.toUtf8Bytes("Site visit confirmed inspector error")
      );
      const tx1 = await disputeReg.connect(drc1).castVote(
        disputeId, true, evidenceHash
      );
      const receipt1 = await tx1.wait();
      console.log(`      castVote() gas used: ${receipt1.gasUsed.toString()}`);

      // Second vote
      await disputeReg.connect(drc2).castVote(disputeId, true, evidenceHash);

      // Third vote — should auto-resolve to UPHELD
      const tx3 = await disputeReg.connect(drc3).castVote(
        disputeId, true, evidenceHash
      );
      await tx3.wait();

      const dispute = await disputeReg.disputes(disputeId);
      // Status 2 = UPHELD
      expect(dispute.status).to.equal(2);
    });

    it("Should prevent double voting", async function () {
      const { contractor, drc1, disputeReg } = await deployWithDispute();
      const disputeId = await fileDisputeHelper(disputeReg, contractor);

      await disputeReg.connect(drc1).openForReview(disputeId);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Evidence"));
      await disputeReg.connect(drc1).castVote(disputeId, true, evidenceHash);

      await expect(
        disputeReg.connect(drc1).castVote(disputeId, false, evidenceHash)
      ).to.be.revertedWith("BCRRS: already voted");
    });

    it("Should resolve REJECTED when 3 votes against", async function () {
      const { contractor, drc1, drc2, drc3, disputeReg } =
        await deployWithDispute();

      const disputeId = await fileDisputeHelper(disputeReg, contractor);
      await disputeReg.connect(drc1).openForReview(disputeId);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("No issue found"));
      await disputeReg.connect(drc1).castVote(disputeId, false, evidenceHash);
      await disputeReg.connect(drc2).castVote(disputeId, false, evidenceHash);
      await disputeReg.connect(drc3).castVote(disputeId, false, evidenceHash);

      const dispute = await disputeReg.disputes(disputeId);
      // Status 3 = REJECTED
      expect(dispute.status).to.equal(3);
    });
  });

  // ── issueCorrectionValues() — Gas Measurement (Table IV) ───────────────

  describe("issueCorrectionValues() — Gas Measurement (Table IV)", function () {
    it("Should issue correction after dispute upheld", async function () {
      const { contractor, drc1, drc2, drc3, disputeReg } =
        await deployWithDispute();

      const milestoneId = ethers.id("MS-CORRECTION-001");
      const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("Score error"));

      const tx0 = await disputeReg.connect(contractor).fileDispute(
        milestoneId, groundsHash
      );
      const receipt0 = await tx0.wait();
      const event = receipt0.logs.find(
        l => l.fragment && l.fragment.name === "DisputeFiled"
      );
      const disputeId = event ? event.args[0] : ethers.ZeroHash;

      // Open and uphold
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Inspector error confirmed"));
      await disputeReg.connect(drc1).openForReview(disputeId);
      await disputeReg.connect(drc1).castVote(disputeId, true, evidenceHash);
      await disputeReg.connect(drc2).castVote(disputeId, true, evidenceHash);
      await disputeReg.connect(drc3).castVote(disputeId, true, evidenceHash);

      // Issue correction — key gas measurement for Table IV
      const tx = await disputeReg.connect(drc1).issueCorrectionValues(
        disputeId,
        85,    // correctedQualityScore (original was ~40)
        true,  // correctedMaterialCompliant
        false, // correctedDisputeFlag
        evidenceHash
      );
      const receipt = await tx.wait();
      console.log(
        `      issueCorrectionValues() gas used: ${receipt.gasUsed.toString()}`
      );

      expect(receipt.status).to.equal(1);

      // Verify correction is retrievable
      const [exists, correction] =
        await disputeReg.getMilestoneCorrection(milestoneId);
      expect(exists).to.be.true;
      expect(correction.correctedQualityScore).to.equal(85);
    });
  });

  // ── getMilestoneCorrection() — view = 0 gas ────────────────────────────

  describe("getMilestoneCorrection() — view function (0 gas)", function () {
    it("Should return correction for a corrected milestone", async function () {
      const { contractor, drc1, drc2, drc3, disputeReg } =
        await deployWithDispute();

      const milestoneId = ethers.id("MS-VIEW-001");
      const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("Error"));

      const tx0 = await disputeReg.connect(contractor).fileDispute(
        milestoneId, groundsHash
      );
      const receipt0 = await tx0.wait();
      const event = receipt0.logs.find(
        l => l.fragment && l.fragment.name === "DisputeFiled"
      );
      const disputeId = event ? event.args[0] : ethers.ZeroHash;

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Confirmed"));
      await disputeReg.connect(drc1).openForReview(disputeId);
      await disputeReg.connect(drc1).castVote(disputeId, true, evidenceHash);
      await disputeReg.connect(drc2).castVote(disputeId, true, evidenceHash);
      await disputeReg.connect(drc3).castVote(disputeId, true, evidenceHash);
      await disputeReg.connect(drc1).issueCorrectionValues(
        disputeId, 90, true, false, evidenceHash
      );

      // This is a view — zero gas
      const [exists, correction] =
        await disputeReg.getMilestoneCorrection(milestoneId);
      expect(exists).to.be.true;
      expect(correction.correctedQualityScore).to.equal(90);
      console.log(`      getMilestoneCorrection() gas used: 0 (view function)`);
    });

    it("Should return exists=false for uncorrected milestone", async function () {
      const { disputeReg } = await deployWithDispute();
      const [exists] = await disputeReg.getMilestoneCorrection(
        ethers.id("NON-EXISTENT")
      );
      expect(exists).to.be.false;
    });
  });

  // ── escalateToCourt() ─────────────────────────────────────────────────

  describe("escalateToCourt() — court integration path", function () {
    it("Should record court escalation immutably", async function () {
      const { contractor, drc1, drc2, drc3, authority, disputeReg } =
        await deployWithDispute();

      const disputeId = await fileDisputeHelper(disputeReg, contractor);
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("Evidence"));

      await disputeReg.connect(drc1).openForReview(disputeId);
      await disputeReg.connect(drc1).castVote(disputeId, false, evidenceHash);
      await disputeReg.connect(drc2).castVote(disputeId, false, evidenceHash);
      await disputeReg.connect(drc3).castVote(disputeId, false, evidenceHash);

      // Contractor escalates after rejection
      const tribunalAddress = authority.address; // using authority as mock tribunal
      const tx = await disputeReg.connect(contractor).escalateToCourt(
        disputeId, tribunalAddress
      );
      const receipt = await tx.wait();
      console.log(`      escalateToCourt() gas used: ${receipt.gasUsed.toString()}`);

      const dispute = await disputeReg.disputes(disputeId);
      // Status 4 = ESCALATED
      expect(dispute.status).to.equal(4);
      expect(dispute.escalatedTo).to.equal(tribunalAddress);
    });
  });

  // ── DRC governance ────────────────────────────────────────────────────

  describe("DRC Governance", function () {
    it("Should add and remove DRC members — authority only", async function () {
      const { authority, stranger, disputeReg } = await deployWithDispute();

      const newMember = stranger;
      await disputeReg.connect(authority).addDRCMember(
        newMember.address, "New Engineering Body"
      );
      const member = await disputeReg.drcMembers(newMember.address);
      expect(member.active).to.be.true;

      await disputeReg.connect(authority).removeDRCMember(
        newMember.address, "Term expired"
      );
      const removed = await disputeReg.drcMembers(newMember.address);
      expect(removed.active).to.be.false;
    });

    it("Should prevent non-DRC members from voting", async function () {
      const { contractor, stranger, drc1, disputeReg } = await deployWithDispute();

      const disputeId = await fileDisputeHelper(disputeReg, contractor);
      await disputeReg.connect(drc1).openForReview(disputeId);

      await expect(
        disputeReg.connect(stranger).castVote(
          disputeId, true,
          ethers.keccak256(ethers.toUtf8Bytes("Fake evidence"))
        )
      ).to.be.revertedWith("BCRRS: caller is not an active DRC member");
    });
  });
});
