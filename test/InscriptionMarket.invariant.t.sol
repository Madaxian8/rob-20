// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InscriptionMarket} from "../src/InscriptionMarket.sol";

/// Drives random sequences of every ETH-bearing market operation.
contract MarketHandler is Test {
    InscriptionMarket public market;
    address public operator;
    address[] public actors;
    uint256[] public bidIds;
    uint256[] public activeListings;

    constructor(InscriptionMarket m, address op) {
        market = m;
        operator = op;
        for (uint256 i = 0; i < 4; i++) actors.push(makeAddr(string(abi.encodePacked("actor", vm.toString(i)))));
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function placeBid(uint256 actorSeed, uint128 price) public {
        price = uint128(bound(price, 1, 1 ether));
        uint256 escrow = uint256(price) + (uint256(price) * 500) / 10000;
        address a = _actor(actorSeed);
        vm.deal(a, a.balance + escrow);
        vm.prank(a);
        bidIds.push(market.placeBid{value: escrow}("robin", 1000, price));
    }

    function cancelBid(uint256 idxSeed) public {
        if (bidIds.length == 0) return;
        uint256 id = bidIds[idxSeed % bidIds.length];
        (address bidder,,,, InscriptionMarket.BidStatus st) = market.bids(id);
        if (st != InscriptionMarket.BidStatus.Open) return;
        vm.prank(bidder);
        market.cancelBid(id);
    }

    function settleBid(uint256 idxSeed, uint256 sellerSeed) public {
        if (bidIds.length == 0) return;
        uint256 id = bidIds[idxSeed % bidIds.length];
        (,,,, InscriptionMarket.BidStatus st) = market.bids(id);
        if (st != InscriptionMarket.BidStatus.Open) return;
        vm.prank(operator);
        market.settleBid(id, _actor(sellerSeed));
    }

    function listAndConfirm(uint256 sellerSeed, uint128 price) public {
        price = uint128(bound(price, 1, 1 ether));
        bytes memory data = abi.encodePacked(
            'data:,{"p":"rob-20","op":"list","tick":"robin","amt":"1000","price":"', vm.toString(uint256(price)), '"}'
        );
        vm.prank(_actor(sellerSeed));
        (bool ok,) = address(market).call(data);
        if (!ok) return;
        uint256 id = market.nextId() - 1;
        vm.prank(operator);
        market.confirm(id);
        activeListings.push(id);
    }

    function buy(uint256 idxSeed, uint256 buyerSeed) public {
        if (activeListings.length == 0) return;
        uint256 id = activeListings[idxSeed % activeListings.length];
        (,, uint128 amt, uint128 price, InscriptionMarket.Status st) = market.listings(id);
        amt;
        if (st != InscriptionMarket.Status.Active) return;
        uint256 pay = uint256(price) + (uint256(price) * 500) / 10000;
        address b = _actor(buyerSeed);
        vm.deal(b, b.balance + pay);
        vm.prank(b);
        market.buy{value: pay}(id);
    }

    function claim(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        if (market.pendingProceeds(a) == 0) return;
        vm.prank(a);
        market.claimProceeds();
    }

    // ---- exposed for the invariant ----
    function numActors() external view returns (uint256) {
        return actors.length;
    }

    function openBidEscrow() external view returns (uint256 total) {
        for (uint256 i = 0; i < bidIds.length; i++) {
            (,,, uint128 price, InscriptionMarket.BidStatus st) = market.bids(bidIds[i]);
            if (st == InscriptionMarket.BidStatus.Open) {
                total += uint256(price) + (uint256(price) * 500) / 10000;
            }
        }
    }

    function pendingTotal() external view returns (uint256 total) {
        for (uint256 i = 0; i < actors.length; i++) total += market.pendingProceeds(actors[i]);
    }
}

contract InscriptionMarketInvariant is Test {
    InscriptionMarket market;
    MarketHandler handler;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");

    function setUp() public {
        market = new InscriptionMarket(owner, operator);
        handler = new MarketHandler(market, operator);
        targetContract(address(handler));
    }

    /// Solvency: the contract always holds EXACTLY what it owes — withdrawable
    /// fees + parked seller proceeds + open-bid escrows (refundable to bidders).
    /// No ETH is ever created, lost, or stranded across any operation sequence.
    function invariant_marketSolvency() public view {
        uint256 owed = market.accruedFees() + handler.pendingTotal() + handler.openBidEscrow();
        assertEq(address(market).balance, owed, "market holds exactly what it owes");
    }
}
