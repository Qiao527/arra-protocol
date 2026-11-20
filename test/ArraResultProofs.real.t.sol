// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArraResultProofs} from "../src/ArraResultProofs.sol";

/// A real Reclaim zkFetch proof of api.gemini.com (test/fixtures/reclaim-xrp-proof.json),
/// verified by the contract exactly as it would be on Arc.
contract ArraResultProofsRealTest is Test {
    ArraResultProofs proofs;
    address constant RECLAIM_ATTESTOR = 0x244897572368Eadf65bfBc5aec98D8e5443a9072;

    function setUp() public {
        proofs = new ArraResultProofs(address(this));
    }

    function _claim() internal pure returns (ArraResultProofs.Claim memory) {
        return ArraResultProofs.Claim({
            provider: "http",
            parameters: "{\"body\":\"\",\"headers\":{\"User-Agent\":\"reclaim/0.0.1\",\"accept\":\"application/json\"},\"method\":\"GET\",\"responseMatches\":[{\"type\":\"regex\",\"value\":\"\\\"instrumentSymbol\\\":\\\"GEMI-XRP2611200200-HI0D88\\\"[^{}]*?\\\"resolutionSide\\\":\\\"yes\\\"\"}],\"responseRedactions\":[],\"url\":\"https://api.gemini.com/v1/prediction-markets/events/XRP2611200200\"}",
            context: "{\"providerHash\":\"0x6dacd64dc17a8cec0f648c77c8a10817be9be8fe645d4dd62d00c1f9a9443740\"}",
            owner: 0xf1c1AF9B96199E180dfeEa453E1a90269bfcf084,
            timestampS: 1795142085,
            epoch: 1
        });
    }

    bytes constant SIG = hex"d588d30939e321aa6ef62f420a6e1d9bab6c6d5bfc28a1fb67fab81c58352fb04e9ca4c1ebf3cd934ef3125339352353545ba225e1644d9186ea5b599e835a7a1b";

    function test_realProofRecoversReclaimAttestor() public {
        vm.expectRevert(abi.encodeWithSelector(ArraResultProofs.UntrustedAttestor.selector, RECLAIM_ATTESTOR));
        proofs.prove("XRP2611200200", "GEMI-XRP2611200200-HI0D88", _claim(), SIG);
        proofs.setAttestor(RECLAIM_ATTESTOR, true);
        bytes32 eventId = proofs.prove("XRP2611200200", "GEMI-XRP2611200200-HI0D88", _claim(), SIG);
        (bytes32 id,,,) = proofs.proofOf(eventId);
        assertEq(id, 0x7462f07a0a3076d11c6edc01a981393f6c80ec1c65172879dbfb91928dd4c957);
    }

    function test_expectedParametersEqualRealClaimBytes() public view {
        assertEq(keccak256(proofs.expectedParameters("XRP2611200200", "GEMI-XRP2611200200-HI0D88")), keccak256(bytes(_claim().parameters)));
    }

    function test_realProofCannotClaimAnotherWinner() public {
        proofs.setAttestor(RECLAIM_ATTESTOR, true);
        vm.expectRevert(ArraResultProofs.WrongParameters.selector);
        proofs.prove("XRP2611200200", "GEMI-XRP2611200200-HI0D96", _claim(), SIG);
    }
}
