/**
 * BCRRS Deployment Script
 * =======================
 * Deploys all three BCRRS smart contracts in the correct order:
 *   1. ContractorRegistry  (no dependencies)
 *   2. ReputationLedger    (depends on: authority, milestone address — placeholder first)
 *   3. ProjectMilestone    (depends on: registry, ledger)
 *   4. Wire up: update ReputationLedger with real milestone contract address
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hardhat
 *   npx hardhat run scripts/deploy.js --network sepolia
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=".repeat(60));
  console.log("  BCRRS — Deployment Script");
  console.log("=".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(
    `  Balance  : ${ethers.formatEther(
      await ethers.provider.getBalance(deployer.address)
    )} ETH`
  );
  console.log("=".repeat(60));

  // ── Step 1: Deploy ContractorRegistry ────────────────────────
  console.log("\n[1/4] Deploying ContractorRegistry...");
  const ContractorRegistry = await ethers.getContractFactory(
    "ContractorRegistry"
  );
  const registry = await ContractorRegistry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`      ContractorRegistry deployed: ${registryAddress}`);

  // ── Step 2: Deploy ReputationLedger (placeholder milestone addr) ─
  console.log("\n[2/4] Deploying ReputationLedger...");
  const ReputationLedger = await ethers.getContractFactory("ReputationLedger");
  // Use deployer as placeholder milestone address — will be updated in step 4
  const ledger = await ReputationLedger.deploy(
    deployer.address,
    deployer.address // placeholder
  );
  await ledger.waitForDeployment();
  const ledgerAddress = await ledger.getAddress();
  console.log(`      ReputationLedger deployed:   ${ledgerAddress}`);

  // ── Step 3: Deploy ProjectMilestone ──────────────────────────
  console.log("\n[3/4] Deploying ProjectMilestone...");
  const ProjectMilestone = await ethers.getContractFactory("ProjectMilestone");
  const milestone = await ProjectMilestone.deploy(
    deployer.address,
    registryAddress,
    ledgerAddress
  );
  await milestone.waitForDeployment();
  const milestoneAddress = await milestone.getAddress();
  console.log(`      ProjectMilestone deployed:   ${milestoneAddress}`);

  // ── Step 4: Wire up ReputationLedger with real milestone address ─
  console.log("\n[4/4] Wiring contracts...");
  const tx = await ledger.setMilestoneContract(milestoneAddress);
  await tx.wait();
  console.log(`      ReputationLedger.milestoneContract set to: ${milestoneAddress}`);

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  Deployment Complete");
  console.log("=".repeat(60));
  console.log(`  ContractorRegistry : ${registryAddress}`);
  console.log(`  ReputationLedger   : ${ledgerAddress}`);
  console.log(`  ProjectMilestone   : ${milestoneAddress}`);
  console.log(`  Authority          : ${deployer.address}`);
  console.log("=".repeat(60));
  console.log("\n  Add these to your .env or update the paper's Table III.\n");

  // Return addresses for use in tests
  return { registry, ledger, milestone };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
