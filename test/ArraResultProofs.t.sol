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

    string constant URL = "https://api.gemini.com/v1/prediction-markets/events/";

    /// The parameters Arra's prover sends (same bytes as a real zkFetch claim, see the real-proof test).
    function _params(string memory ticker, string memory symbol) internal pure returns (string memory) {
        return _paramsWith(ticker, symbol, '""', "", '"responseRedactions":[]', URL);
    }

    /// Build variants: `regexTail` is appended inside the regex, `matchExtra` inside the match object.
    function _paramsWith(string memory ticker, string memory symbol, string memory regexTail, string memory matchExtra, string memory redactions, string memory url)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '{"body":"","headers":{"User-Agent":"reclaim/0.0.1","accept":"application/json"},"method":"GET",',
            '"responseMatches":[{"type":"regex","value":"\\"instrumentSymbol\\":\\"',
            symbol,
            '\\"[^{}]*?\\"resolutionSide\\":\\"yes\\',
            regexTail,
            matchExtra,
            '}],',
            redactions,
            ',"url":"',
            url,
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

    function test_syntheticParamsMatchContract() public view {
        assertEq(keccak256(bytes(_params(TICKER, WIN))), keccak256(proofs.expectedParameters(TICKER, WIN)));
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
        vm.expectRevert(ArraResultProofs.WrongParameters.selector);
        proofs.prove(TICKER, WIN, c, sig);
    }

    function test_rejectsOtherWinner() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(attestorKey, c);
        vm.expectRevert(ArraResultProofs.WrongParameters.selector);
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

    // Z-1 (review): each of these is signed by a trusted attestor yet proves nothing about the winner.
    function _expectForgeryRejected(string memory params) internal {
        ArraResultProofs.Claim memory c = _claim(params);
        bytes memory sig = _sign(attestorKey, c);
        vm.expectRevert(ArraResultProofs.WrongParameters.selector);
        proofs.prove(TICKER, WIN, c, sig);
    }

    function test_rejectsRegexWithExtraBranch() public {
        _expectForgeryRejected(_paramsWith(TICKER, WIN, '|\\"ticker\\"\"', "", '"responseRedactions":[]', URL));
    }

    function test_rejectsInvertedMatch() public {
        _expectForgeryRejected(_paramsWith(TICKER, WIN, '""', ',"invert":true', '"responseRedactions":[]', URL));
    }

    function test_rejectsRedactions() public {
        _expectForgeryRejected(_paramsWith(TICKER, WIN, '""', "", '"responseRedactions":[{"regex":".*"}]', URL));
    }

    function test_rejectsOtherHostWithGeminiUrlInHeader() public {
        string memory p = string.concat(
            '{"body":"","headers":{"url":"https://api.gemini.com/v1/prediction-markets/events/', TICKER,
            '"},"method":"GET","responseMatches":[{"type":"regex","value":"\\"instrumentSymbol\\":\\"', WIN,
            '\\"[^{}]*?\\"resolutionSide\\":\\"yes\\""}],"responseRedactions":[],"url":"https://evil.example/x"}'
        );
        _expectForgeryRejected(p);
    }

    function test_guardianCanClear() public {
        ArraResultProofs.Claim memory c = _claim(_params(TICKER, WIN));
        bytes memory sig = _sign(attestorKey, c);
        bytes32 eventId = proofs.prove(TICKER, WIN, c, sig);
        proofs.clear(eventId);
        (bytes32 id,,,) = proofs.proofOf(eventId);
        assertEq(id, bytes32(0));
        proofs.prove(TICKER, WIN, c, sig); // can be recorded again
        vm.prank(address(0xCAFE));
        vm.expectRevert();
        proofs.clear(eventId);
    }

    function test_onlyOwnerSetsAttestors() public {
        vm.prank(address(0xCAFE));
        vm.expectRevert();
        proofs.setAttestor(address(1), true);
    }
}
