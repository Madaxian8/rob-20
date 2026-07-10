// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InscriptionHub} from "../src/InscriptionHub.sol";

contract MintProxy {
    function tryMint(InscriptionHub hub, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = address(hub).call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

contract InscriptionHubTest is Test {
    InscriptionHub hub;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant ROBIN = keccak256("robin");
    bytes constant ROBIN_MINT = 'data:,{"p":"rob-20","op":"mint","tick":"robin","amt":"1000"}';

    function setUp() public {
        hub = new InscriptionHub();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.prank(deployer);
        hub.deployTick("robin", 21_000, 1000, 10, 0.001 ether);
    }

    function _mint(address who, uint256 value, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who, who);
        (ok, ret) = address(hub).call{value: value}(data);
    }

    // ---- deployTick ----

    function test_DeployTickStoresConfig() public view {
        (address dep, uint64 maxM, uint64 total, uint32 wlim, uint128 apm, uint128 price) = hub.ticks(ROBIN);
        assertEq(dep, deployer);
        assertEq(maxM, 21_000);
        assertEq(total, 0);
        assertEq(wlim, 10);
        assertEq(apm, 1000);
        assertEq(price, 0.001 ether);
    }

    function test_RevertWhen_TickDuplicate() public {
        vm.expectRevert(InscriptionHub.TickExists.selector);
        hub.deployTick("robin", 1, 1, 1, 0);
    }

    function test_RevertWhen_TickMalformed() public {
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("Robin", 1, 1, 1, 0); // uppercase
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("ninechars", 1, 1, 1, 0); // 9 chars
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("", 1, 1, 1, 0);
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("ro bin", 1, 1, 1, 0); // space
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick(unicode"röbin", 1, 1, 1, 0); // non-ascii
    }

    function test_RevertWhen_ParamsOutOfRange() public {
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 0, 1, 1, 0); // maxMints 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 1e9 + 1, 1, 1, 0);
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 0, 1, 0); // amountPerMint 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1e15 + 1, 1, 0);
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 0, 0); // walletLimit 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 101, 0); // walletLimit > maxMints
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 100 ether + 1 wei);
    }

    function test_AnyoneCanDeployTicks() public {
        vm.prank(alice);
        hub.deployTick("free", 100, 5, 2, 0);
        (address dep,,,,, uint128 price) = hub.ticks(keccak256("free"));
        assertEq(dep, alice);
        assertEq(price, 0);
    }

    // ---- mint: happy paths ----

    function test_MintPaidTick() public {
        vm.expectEmit(true, true, false, true);
        emit InscriptionHub.Inscribed(ROBIN, alice, 1);
        (bool ok,) = _mint(alice, 0.001 ether, ROBIN_MINT);
        assertTrue(ok);

        (,, uint64 total,,,) = hub.ticks(ROBIN);
        assertEq(total, 1);
        assertEq(hub.mintsOf(ROBIN, alice), 1);
        assertEq(hub.pendingFees(deployer), 0.001 ether);
    }

    function test_MintFreeTick() public {
        vm.prank(bob);
        hub.deployTick("free", 100, 5, 2, 0);
        (bool ok,) = _mint(alice, 0, 'data:,{"p":"rob-20","op":"mint","tick":"free","amt":"5"}');
        assertTrue(ok);
        assertEq(hub.pendingFees(bob), 0);
    }

    function test_EightCharTickAndSingleDigitAmt() public {
        vm.prank(bob);
        hub.deployTick("abcd1234", 10, 7, 10, 0);
        (bool ok,) = _mint(alice, 0, 'data:,{"p":"rob-20","op":"mint","tick":"abcd1234","amt":"7"}');
        assertTrue(ok);
        assertEq(hub.mintsOf(keccak256("abcd1234"), alice), 1);
    }

    // ---- mint: rejections ----

    function test_RevertWhen_UnknownTick() public {
        (bool ok, bytes memory ret) = _mint(alice, 0, 'data:,{"p":"rob-20","op":"mint","tick":"nope","amt":"1"}');
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.UnknownTick.selector);
    }

    function test_RevertWhen_AmtMismatchesConfig() public {
        (bool ok, bytes memory ret) = _mint(alice, 0.001 ether, 'data:,{"p":"rob-20","op":"mint","tick":"robin","amt":"999"}');
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
    }

    function test_RevertWhen_WrongValue() public {
        (bool okLow, bytes memory retLow) = _mint(alice, 0.0009 ether, ROBIN_MINT);
        assertFalse(okLow);
        assertEq(bytes4(retLow), InscriptionHub.WrongPayment.selector);
        (bool okHigh, bytes memory retHigh) = _mint(alice, 0.0011 ether, ROBIN_MINT);
        assertFalse(okHigh);
        assertEq(bytes4(retHigh), InscriptionHub.WrongPayment.selector);
    }

    function test_RevertWhen_TextNotCanonical() public {
        bytes[] memory bad = new bytes[](7);
        bad[0] = bytes('data:,{"p":"rob-20","op":"mint","tick":"robin","amt":"1000"} ');
        bad[1] = bytes('data:,{"p":"rob-20","op":"mint","tick":"robin","amt":"01000"}'); // leading zero
        bad[2] = bytes('data:,{"p":"rob-20","op":"mint","tick":"ROBIN","amt":"1000"}'); // uppercase tick
        bad[3] = bytes('data:,{"p":"rob-20","op":"mint","tick":"robin","amt":""}'); // empty amt
        bad[4] = bytes('data:,{"p":"rob-20","op":"transfer","tick":"robin","amt":"1000"}');
        bad[5] = bytes('data:,{ "p":"rob-20","op":"mint","tick":"robin","amt":"1000"}'); // space
        bad[6] = bytes("");

        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(alice, alice);
            (bool ok, bytes memory ret) = address(hub).call{value: 0.001 ether}(bad[i]);
            assertFalse(ok, string(abi.encodePacked("case ", vm.toString(i))));
            assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
        }
        (,, uint64 total,,,) = hub.ticks(ROBIN);
        assertEq(total, 0);
        assertEq(address(hub).balance, 0);
    }

    function test_RevertWhen_WalletLimitExceeded() public {
        for (uint256 i = 0; i < 10; i++) {
            (bool ok,) = _mint(alice, 0.001 ether, ROBIN_MINT);
            assertTrue(ok);
        }
        (bool ok11, bytes memory ret) = _mint(alice, 0.001 ether, ROBIN_MINT);
        assertFalse(ok11);
        assertEq(bytes4(ret), InscriptionHub.ExceedsWalletLimit.selector);
    }

    function test_RevertWhen_SoldOut() public {
        vm.prank(bob);
        hub.deployTick("tiny", 3, 100, 3, 0);
        bytes memory data = 'data:,{"p":"rob-20","op":"mint","tick":"tiny","amt":"100"}';
        for (uint256 i = 0; i < 3; i++) {
            (bool ok,) = _mint(alice, 0, data);
            assertTrue(ok);
        }
        (bool ok4, bytes memory ret) = _mint(bob, 0, data);
        assertFalse(ok4);
        assertEq(bytes4(ret), InscriptionHub.SoldOut.selector);
    }

    function test_RevertWhen_CallerIsContract() public {
        MintProxy proxy = new MintProxy();
        vm.prank(alice, alice);
        vm.expectRevert(InscriptionHub.ContractCallerNotAllowed.selector);
        proxy.tryMint{value: 0.001 ether}(hub, ROBIN_MINT);
    }

    // ---- fees ----

    function test_WithdrawFees() public {
        _mint(alice, 0.001 ether, ROBIN_MINT);
        _mint(bob, 0.001 ether, ROBIN_MINT);
        assertEq(hub.pendingFees(deployer), 0.002 ether);

        vm.prank(deployer);
        hub.withdrawFees();
        assertEq(deployer.balance, 0.002 ether);
        assertEq(hub.pendingFees(deployer), 0);

        vm.prank(deployer);
        vm.expectRevert(InscriptionHub.NoFees.selector);
        hub.withdrawFees();
    }

    // ---- fuzz ----

    function testFuzz_NonCanonicalCalldataNeverMints(bytes calldata data) public {
        vm.assume(keccak256(data) != keccak256(ROBIN_MINT));
        vm.prank(alice, alice);
        (bool ok,) = address(hub).call{value: 0.001 ether}(data);
        ok;
        (,, uint64 total,,,) = hub.ticks(ROBIN);
        assertEq(total, 0);
        assertEq(address(hub).balance, 0);
    }

    function testFuzz_MintOnlyWithExactPrice(uint256 value) public {
        value = bound(value, 0, 1 ether);
        vm.assume(value != 0.001 ether);
        (bool ok,) = _mint(alice, value, ROBIN_MINT);
        assertFalse(ok);
    }
}
