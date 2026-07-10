// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title InscriptionHub — permissionless rob-20 tick registry and mint gatekeeper
/// @notice NOT a token. Inscriptions live in transaction calldata; balances are
///         computed by the off-chain rob-20 indexer (PROTOCOL.md). This contract
///         registers ticks and guards mints: a mint transaction carries the raw
///         canonical inscription text, which is parsed ON-CHAIN and checked
///         against the tick's rules — any violation reverts the whole tx, so
///         nobody can lose a mint fee to an invalid mint. Mint fees accrue to
///         each tick's deployer (pull-based). The Hub has no owner.
contract InscriptionHub {
    // canonical mint inscription: PREFIX <tick> AMT_MARKER <amt> TAIL
    bytes internal constant PREFIX = 'data:,{"p":"rob-20","op":"mint","tick":"';
    bytes internal constant AMT_MARKER = '","amt":"';
    bytes internal constant TAIL = '"}';

    struct TickConfig {
        address deployer;
        uint64 maxMints;
        uint64 totalMints;
        uint32 walletLimit;
        uint128 amountPerMint;
        uint128 mintPrice;
    }

    mapping(bytes32 tickHash => TickConfig) public ticks;
    mapping(bytes32 tickHash => mapping(address wallet => uint64)) public mintsOf;
    mapping(address deployer => uint256) public pendingFees;

    event Deployed(
        bytes32 indexed tickHash,
        address indexed deployer,
        string tick,
        uint64 maxMints,
        uint128 amountPerMint,
        uint32 walletLimit,
        uint128 mintPrice
    );
    event Inscribed(bytes32 indexed tickHash, address indexed minter, uint64 inscriptionNumber);

    error BadTick();
    error TickExists();
    error BadParams();
    error BadInscription();
    error UnknownTick();
    error WrongPayment();
    error SoldOut();
    error ExceedsWalletLimit();
    error ContractCallerNotAllowed();
    error NoFees();

    // ---- deploy ----

    function deployTick(
        string calldata tick,
        uint64 maxMints,
        uint128 amountPerMint,
        uint32 walletLimit,
        uint128 mintPrice
    ) external {
        bytes calldata t = bytes(tick);
        if (t.length == 0 || t.length > 8) revert BadTick();
        for (uint256 i = 0; i < t.length; i++) {
            bytes1 c = t[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39); // [a-z0-9]
            if (!ok) revert BadTick();
        }
        bytes32 th = keccak256(t);
        if (ticks[th].deployer != address(0)) revert TickExists();
        if (maxMints == 0 || maxMints > 1e9) revert BadParams();
        if (amountPerMint == 0 || amountPerMint > 1e15) revert BadParams();
        if (walletLimit == 0 || walletLimit > maxMints) revert BadParams();
        if (mintPrice > 100 ether) revert BadParams();

        ticks[th] = TickConfig({
            deployer: msg.sender,
            maxMints: maxMints,
            totalMints: 0,
            walletLimit: walletLimit,
            amountPerMint: amountPerMint,
            mintPrice: mintPrice
        });
        emit Deployed(th, msg.sender, tick, maxMints, amountPerMint, walletLimit, mintPrice);
    }

    // ---- mint (raw inscription calldata hits the fallback) ----

    /// @dev Rejecting contract callers keeps a factory from sweeping a tick's
    ///      supply through many child contracts in a single transaction.
    fallback() external payable {
        if (msg.sender != tx.origin) revert ContractCallerNotAllowed();

        (bytes32 th, uint256 amt) = _parseMint(msg.data);

        TickConfig storage cfg = ticks[th];
        if (cfg.deployer == address(0)) revert UnknownTick();
        if (amt != cfg.amountPerMint) revert BadInscription();
        if (msg.value != cfg.mintPrice) revert WrongPayment();
        if (cfg.totalMints >= cfg.maxMints) revert SoldOut();

        uint64 walletMints = mintsOf[th][msg.sender] + 1;
        if (walletMints > cfg.walletLimit) revert ExceedsWalletLimit();

        mintsOf[th][msg.sender] = walletMints;
        uint64 n;
        unchecked {
            n = ++cfg.totalMints;
        }
        if (msg.value > 0) pendingFees[cfg.deployer] += msg.value;
        emit Inscribed(th, msg.sender, n);
    }

    /// @dev Plain ETH transfers (empty calldata) are not mints — reject them.
    receive() external payable {
        revert BadInscription();
    }

    /// @dev Strict byte-exact parse of the canonical mint inscription.
    ///      Returns (keccak256(tick), amt). Reverts on ANY deviation.
    function _parseMint(bytes calldata d) internal pure returns (bytes32 th, uint256 amt) {
        uint256 pLen = PREFIX.length;
        uint256 mLen = AMT_MARKER.length;
        // minimum: prefix + 1-char tick + marker + 1-digit amt + tail
        if (d.length < pLen + 1 + mLen + 1 + TAIL.length) revert BadInscription();
        if (keccak256(d[:pLen]) != keccak256(PREFIX)) revert BadInscription();

        // tick: 1-8 chars of [a-z0-9]
        uint256 i = pLen;
        while (i < d.length && i - pLen < 8) {
            bytes1 c = d[i];
            if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) i++;
            else break;
        }
        uint256 tickLen = i - pLen;
        if (tickLen == 0) revert BadInscription();
        th = keccak256(d[pLen:i]);

        if (i + mLen > d.length || keccak256(d[i:i + mLen]) != keccak256(AMT_MARKER)) revert BadInscription();
        i += mLen;

        // amt: decimal digits, no leading zero, bounded length (amountPerMint <= 1e15 => 16 digits)
        uint256 amtStart = i;
        while (i < d.length) {
            bytes1 c = d[i];
            if (c < 0x30 || c > 0x39) break;
            amt = amt * 10 + (uint8(c) - 48);
            i++;
        }
        uint256 amtLen = i - amtStart;
        if (amtLen == 0 || amtLen > 16 || (amtLen > 1 && d[amtStart] == "0")) revert BadInscription();

        if (d.length != i + TAIL.length || keccak256(d[i:]) != keccak256(TAIL)) revert BadInscription();
    }

    // ---- deployer fee withdrawal (pull) ----

    function withdrawFees() external {
        uint256 amount = pendingFees[msg.sender];
        if (amount == 0) revert NoFees();
        pendingFees[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}
