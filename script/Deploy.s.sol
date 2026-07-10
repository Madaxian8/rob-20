// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InscriptionHub} from "../src/InscriptionHub.sol";
import {InscriptionMarket} from "../src/InscriptionMarket.sol";

/// Usage:
///   OWNER=<platform-owner> OPERATOR=<oracle-address> forge script script/Deploy.s.sol \
///     --rpc-url robinhood --account <keystore-account> --broadcast
/// OWNER / OPERATOR default to the broadcasting wallet if unset.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        address operator = vm.envOr("OPERATOR", msg.sender);

        InscriptionHub hub = new InscriptionHub();
        InscriptionMarket market = new InscriptionMarket(owner, operator);
        vm.stopBroadcast();

        console.log("InscriptionHub:   ", address(hub));
        console.log("InscriptionMarket:", address(market));
        console.log("Market owner:     ", owner);
        console.log("Market operator:  ", operator);
        console.log("Next: fill indexer/config.json, deploy the genesis tick, start indexer + oracle.");
    }
}
