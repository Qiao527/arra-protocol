// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Arra result proofs
/// @notice Onchain check of a zkTLS (Reclaim zkFetch) proof that api.gemini.com reported a
///         contract as resolved YES. The settlers' vote carries a hash of Gemini's bytes; this
///         contract adds a proof that those bytes came from Gemini's server, checked by the chain:
///         - the claim's request parameters equal, byte for byte, a GET of Gemini's public event
///           endpoint for exactly this ticker with one regex pinning `instrumentSymbol` = the
///           winning contract followed by `"resolutionSide":"yes"` in the same contract object,
///         - the claim identifier is recomputed from those strings,
///         - and the claim is signed by an attestor the owner trusts.
///         It does not move money. The vault and the proof page read `proofOf(eventId)`.
contract ArraResultProofs is Ownable {
    using Strings for uint256;
    using Strings for address;

    struct Proven {
        bytes32 identifier;
        address attestor;
        uint64 timestampS;
        bytes32 winningSymbolHash;
    }

    string public constant GEMINI_EVENT_URL = "https://api.gemini.com/v1/prediction-markets/events/";

    mapping(address => bool) public attestors;
    /// @dev eventId = keccak256(bytes(eventTicker)), the same id ArraVault uses.
    mapping(bytes32 => Proven) public proofOf;

    event AttestorSet(address indexed attestor, bool trusted);
    event ProofCleared(bytes32 indexed eventId);
    event ResultProven(
        bytes32 indexed eventId,
        string eventTicker,
        string winningSymbol,
        bytes32 identifier,
        address attestor,
        uint64 timestampS
    );

    error NotHttpProvider();
    error WrongParameters();
    error UntrustedAttestor(address signer);
    error AlreadyProven();
    error BadTicker();

    struct Claim {
        string provider;
        string parameters;
        string context;
        address owner;
        uint32 timestampS;
        uint32 epoch;
    }

    constructor(address owner_) Ownable(owner_) {}

    function setAttestor(address a, bool trusted) external onlyOwner {
        attestors[a] = trusted;
        emit AttestorSet(a, trusted);
    }

    /// @notice Remove a record (guardian), e.g. if an attestor is later found compromised.
    function clear(bytes32 eventId) external onlyOwner {
        delete proofOf[eventId];
        emit ProofCleared(eventId);
    }

    /// @notice The exact `parameters` JSON of the zkFetch request that proves `winningSymbol`
    ///         resolved YES in `eventTicker`. The regex sits inside a JSON string, so its quotes
    ///         are escaped.
    function expectedParameters(string calldata eventTicker, string calldata winningSymbol)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            '{"body":"","headers":{"User-Agent":"reclaim/0.0.1","accept":"application/json"},"method":"GET",',
            '"responseMatches":[{"type":"regex","value":"\\"instrumentSymbol\\":\\"',
            winningSymbol,
            '\\"[^{}]*?\\"resolutionSide\\":\\"yes\\""}],"responseRedactions":[],"url":"',
            GEMINI_EVENT_URL,
            eventTicker,
            '"}'
        );
    }

    /// @notice Record a proof that `winningSymbol` resolved YES in Gemini event `eventTicker`.
    function prove(string calldata eventTicker, string calldata winningSymbol, Claim calldata c, bytes calldata signature)
        external
        returns (bytes32 eventId)
    {
        if (!_safeToken(bytes(eventTicker)) || !_safeToken(bytes(winningSymbol))) revert BadTicker();
        if (keccak256(bytes(c.provider)) != keccak256("http")) revert NotHttpProvider();

        // Exact match, not substrings: the claim's parameters must be byte-for-byte the request
        // Arra's prover makes (GET Gemini's event endpoint for this ticker, fixed headers, one regex
        // pinning this contract to "resolutionSide":"yes", no redactions). Any extra regex branch,
        // invert flag, other host, extra header or redaction changes the bytes and fails.
        if (keccak256(bytes(c.parameters)) != keccak256(expectedParameters(eventTicker, winningSymbol))) revert WrongParameters();

        bytes32 identifier = keccak256(abi.encodePacked(c.provider, "\n", c.parameters, "\n", c.context));
        string memory serialised = string.concat(
            uint256(identifier).toHexString(32),
            "\n",
            c.owner.toHexString(),
            "\n",
            uint256(c.timestampS).toString(),
            "\n",
            uint256(c.epoch).toString()
        );
        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(bytes(serialised)), signature);
        if (!attestors[signer]) revert UntrustedAttestor(signer);

        eventId = keccak256(bytes(eventTicker));
        if (proofOf[eventId].identifier != bytes32(0)) revert AlreadyProven();
        proofOf[eventId] = Proven(identifier, signer, c.timestampS, keccak256(bytes(winningSymbol)));
        emit ResultProven(eventId, eventTicker, winningSymbol, identifier, signer, c.timestampS);
    }

    /// @dev tickers and symbols are [A-Z0-9-.]; anything else could smuggle quotes into the needles
    function _safeToken(bytes memory s) private pure returns (bool) {
        if (s.length == 0 || s.length > 96) return false;
        for (uint256 i; i < s.length; i++) {
            bytes1 ch = s[i];
            bool ok = (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == "-" || ch == ".";
            if (!ok) return false;
        }
        return true;
    }
}
