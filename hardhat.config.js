require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    // Local Hardhat network (default)
    hardhat: {
      chainId: 31337,
    },

    // Sepolia testnet — add your own RPC URL and private key
    // in a .env file (never commit private keys to GitHub)
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },

  // Gas reporter — generates Table III in the paper
  gasReporter: {
    enabled: true,
    currency: "USD",
    coinmarketcap: process.env.CMC_API_KEY || "",
    outputFile: "gas-report.txt",
    noColors: true,
  },

  // Etherscan verification (optional)
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
