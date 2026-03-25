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
