// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArraResultProofs} from "../src/ArraResultProofs.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract ArraResultProofsTest is Test {
    using Strings for uint256;
    using Strings for address;

    ArraResultProofs proofs;
    uint256 attestorKey = 0xA77E57;
    address attestor;
    string constant TICKER = "NFL-2611200115-IND-HOU-M";
    string constant WIN = "GEMI-NFL-2611200115-IND-HOU-M-HOU";

    function setUp() public {
        proofs = new ArraResultProofs(address(this));
        attestor = vm.addr(attestorKey);
        proofs.setAttestor(attestor, true);
    }

    function _params(string memory ticker, string memory symbol) internal pure returns (string memory) {
        return string.concat(
            '{"body":"","method":"GET","responseMatches":[{"type":"regex","value":"\\"instrumentSymbol\\":\\"',
            symbol,
            '\\"[^{}]*?\\"resolutionSide\\":\\"yes\\""}],"responseRedactions":[],"url":"https://api.gemini.com/v1/prediction-markets/events/',
            ticker,
            '"}'
        );
    }

    function _claim(string memory params) internal pure returns (ArraResultProofs.Claim memory c) {
        c = ArraResultProofs.Claim({
            provider: "http",
            parameters: params,
            context: '{"contextAddress":"0x0","contextMessage":"arra"}',
            owner: address(0xBEEF),
            timestampS: 1795150000,
            epoch: 1
        });
    }

    function _sign(uint256 key, ArraResultProofs.Claim memory c) internal pure returns (bytes memory) {
        bytes32 id = keccak256(abi.encodePacked(c.provider, "\n", c.parameters, "\n", c.context));
        string memory s = string.concat(
            uint256(id).toHexString(32), "\n", c.owner.toHexString(), "\n", uint256(c.timestampS).toString(), "\n", uint256(c.epoch).toString()
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(bytes(s)));
        return abi.encodePacked(r, sg, v);
    }

    function test_provesResult() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes32 eventId = proofs.prove(TICKER, WIN, c, _sign(attestorKey, c));
        assertEq(eventId, keccak256(bytes(TICKER)));
        (bytes32 id, address a, uint64 ts, bytes32 w) = proofs.proofOf(eventId);
        assertTrue(id != bytes32(0));
        assertEq(a, attestor);
        assertEq(ts, 1795150000);
        assertEq(w, keccak256(bytes(WIN)));
    }

    function test_rejectsUntrustedAttestor() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(0xBAD, c);
        vm.expectRevert(abi.encodeWithSelector(ArraResultProofs.UntrustedAttestor.selector, vm.addr(0xBAD)));
        proofs.prove(TICKER, WIN, c, sig);
    }

    function test_rejectsOtherEventsUrl() public {
        // a real proof for another game can't settle this one
        ArraResultProofs.Claim memory c = _claim(_params("NFL-2611200115-IND-HOU-2HM", WIN));
        bytes memory sig = _sign(attestorKey, c);
        vm.expectRevert(ArraResultProofs.WrongUrl.selector);
        proofs.prove(TICKER, WIN, c, sig);
    }

    function test_rejectsOtherWinner() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(attestorKey, c);
        vm.expectRevert(ArraResultProofs.WrongMatch.selector);
        proofs.prove(TICKER, "GEMI-NFL-2611200115-IND-HOU-M-IND", c, sig);
    }

    function test_rejectsTamperedParameters() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(attestorKey, c);
        c.context = '{"contextAddress":"0x0","contextMessage":"edited"}';
        vm.expectRevert(); // identifier changes, signature recovers to someone else
        proofs.prove(TICKER, WIN, c, sig);
    }

    function test_rejectsQuoteSmuggling() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(attestorKey, c);
        vm.expectRevert(ArraResultProofs.BadTicker.selector);
        proofs.prove(string.concat(TICKER, '"'), WIN, c, sig);
    }

    function test_cannotProveTwice() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(attestorKey, c);
        proofs.prove(TICKER, WIN, c, sig);
        vm.expectRevert(ArraResultProofs.AlreadyProven.selector);
        proofs.prove(TICKER, WIN, c, sig);
    }

    function test_onlyOwnerSetsAttestors() public {
        vm.prank(address(0xCAFE));
        vm.expectRevert();
        proofs.setAttestor(address(1), true);
    }
}
