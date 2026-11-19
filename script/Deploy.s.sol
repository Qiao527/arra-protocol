// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArraVault} from "../src/ArraVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Arc testnet:
///   OPERATOR_ADDRESS=0x.. SETTLERS=0xA,0xB,0xC forge script script/Deploy.s.sol \
///     --rpc-url $ARC_TESTNET_RPC_URL --broadcast --private-key $PRIVATE_KEY
/// Local (anvil): add USE_MOCK_USDC=true
contract Deploy is Script {
    // Arc's native USDC exposes its ERC-20 interface here (6 decimals), testnet and mainnet.
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address[] memory settlers = vm.envAddress("SETTLERS", ",");
        uint8 threshold = uint8(vm.envOr("SETTLER_THRESHOLD", uint256(2)));
        uint64 window = uint64(vm.envOr("DISPUTE_WINDOW_SEC", uint256(1800))); // 30 min; use ~60 for live demos
        uint256 capBps = vm.envOr("EVENT_CAP_BPS", uint256(1_000)); // 10%
        bool useMock = vm.envOr("USE_MOCK_USDC", false);

        vm.startBroadcast();
        address usdc = ARC_USDC;
        if (useMock) {
            usdc = address(new MockUSDC());
            console.log("MockUSDC:", usdc);
        }
        ArraVault vault = new ArraVault(IERC20(usdc), operator, settlers, threshold, window, capBps);
        vm.stopBroadcast();

        console.log("ArraVault:", address(vault));
        console.log("USDC:", usdc);
        console.log("Operator:", operator);
        console.log("Settler threshold:", threshold);
        console.log("Dispute window (s):", window);
    }
}
