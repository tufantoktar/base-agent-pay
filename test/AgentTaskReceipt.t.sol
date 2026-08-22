// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AgentTaskReceipt} from "../src/AgentTaskReceipt.sol";

interface Vm {
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
}

contract MiniTest {
    error AssertionFailed(string message);

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool value, string memory message) internal pure {
        if (!value) {
            revert AssertionFailed(message);
        }
    }

    function assertFalse(bool value, string memory message) internal pure {
        if (value) {
            revert AssertionFailed(message);
        }
    }

    function assertEq(uint256 actual, uint256 expected, string memory message) internal pure {
        if (actual != expected) {
            revert AssertionFailed(message);
        }
    }

    function assertEq(address actual, address expected, string memory message) internal pure {
        if (actual != expected) {
            revert AssertionFailed(message);
        }
    }

    function assertEq(bytes32 actual, bytes32 expected, string memory message) internal pure {
        if (actual != expected) {
            revert AssertionFailed(message);
        }
    }
}

contract AgentTaskReceiptTest is MiniTest {
    event AgentTaskReceiptRecorded(
        bytes32 indexed taskId, address indexed requester, bytes32 requestHash, bytes32 resultHash, uint256 timestamp
    );

    AgentTaskReceipt private receipt;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    bytes32 private constant TASK_ID = bytes32(uint256(1));
    bytes32 private constant TASK_ID_TWO = bytes32(uint256(2));
    bytes32 private constant REQUEST_HASH = bytes32(uint256(101));
    bytes32 private constant REQUEST_HASH_TWO = bytes32(uint256(102));
    bytes32 private constant RESULT_HASH = bytes32(uint256(201));
    bytes32 private constant RESULT_HASH_TWO = bytes32(uint256(202));

    function setUp() public {
        receipt = new AgentTaskReceipt();
    }

    function testInitialReceiptCountIsZero() public view {
        assertEq(receipt.getReceiptCount(), 0, "initial count should be zero");
    }

    function testHasReceiptFalseForUnknownTask() public view {
        assertFalse(receipt.hasReceipt(TASK_ID), "unknown task should not exist");
    }

    function testRecordReceiptStoresRequester() public {
        vm.prank(ALICE);
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        AgentTaskReceipt.Receipt memory stored = receipt.getReceipt(TASK_ID);
        assertEq(stored.requester, ALICE, "requester should be caller");
    }

    function testRecordReceiptStoresTaskId() public {
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        AgentTaskReceipt.Receipt memory stored = receipt.getReceipt(TASK_ID);
        assertEq(stored.taskId, TASK_ID, "task id should be stored");
    }

    function testRecordReceiptStoresHashes() public {
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        AgentTaskReceipt.Receipt memory stored = receipt.getReceipt(TASK_ID);
        assertEq(stored.requestHash, REQUEST_HASH, "request hash should be stored");
        assertEq(stored.resultHash, RESULT_HASH, "result hash should be stored");
    }

    function testRecordReceiptStoresTimestamp() public {
        vm.warp(1_234_567);
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        AgentTaskReceipt.Receipt memory stored = receipt.getReceipt(TASK_ID);
        assertEq(stored.timestamp, 1_234_567, "timestamp should be block timestamp");
    }

    function testReceiptCountIncrements() public {
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);
        assertEq(receipt.getReceiptCount(), 1, "count should increment once");

        receipt.recordReceipt(TASK_ID_TWO, REQUEST_HASH_TWO, RESULT_HASH_TWO);
        assertEq(receipt.getReceiptCount(), 2, "count should increment twice");
    }

    function testEmitsReceiptRecordedEvent() public {
        vm.warp(42);
        vm.expectEmit(true, true, false, true);
        emit AgentTaskReceiptRecorded(TASK_ID, address(this), REQUEST_HASH, RESULT_HASH, 42);

        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);
    }

    function testDuplicateTaskIdReverts() public {
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        vm.expectRevert(abi.encodeWithSelector(AgentTaskReceipt.DuplicateTaskId.selector, TASK_ID));
        receipt.recordReceipt(TASK_ID, REQUEST_HASH_TWO, RESULT_HASH_TWO);
    }

    function testUnknownTaskLookupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentTaskReceipt.UnknownTaskId.selector, TASK_ID));
        receipt.getReceipt(TASK_ID);
    }

    function testMultipleUsersStoreIndependentRequesters() public {
        vm.prank(ALICE);
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        vm.prank(BOB);
        receipt.recordReceipt(TASK_ID_TWO, REQUEST_HASH_TWO, RESULT_HASH_TWO);

        AgentTaskReceipt.Receipt memory aliceReceipt = receipt.getReceipt(TASK_ID);
        AgentTaskReceipt.Receipt memory bobReceipt = receipt.getReceipt(TASK_ID_TWO);
        assertEq(aliceReceipt.requester, ALICE, "alice requester should be stored");
        assertEq(bobReceipt.requester, BOB, "bob requester should be stored");
    }

    function testRequesterSpecificReceiptRetrieval() public {
        vm.prank(ALICE);
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        vm.prank(BOB);
        receipt.recordReceipt(TASK_ID_TWO, REQUEST_HASH_TWO, RESULT_HASH_TWO);

        AgentTaskReceipt.Receipt[] memory aliceReceipts = receipt.getReceiptsByRequester(ALICE);
        assertEq(aliceReceipts.length, 1, "alice should have one receipt");
        assertEq(aliceReceipts[0].taskId, TASK_ID, "alice task should match");
    }

    function testRequesterWithNoReceiptsReturnsEmptyArray() public view {
        AgentTaskReceipt.Receipt[] memory bobReceipts = receipt.getReceiptsByRequester(BOB);
        assertEq(bobReceipts.length, 0, "unknown requester should return empty list");
    }

    function testMultipleReceiptsForSameRequesterMaintainOrder() public {
        vm.prank(ALICE);
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);

        vm.prank(ALICE);
        receipt.recordReceipt(TASK_ID_TWO, REQUEST_HASH_TWO, RESULT_HASH_TWO);

        AgentTaskReceipt.Receipt[] memory aliceReceipts = receipt.getReceiptsByRequester(ALICE);
        assertEq(aliceReceipts.length, 2, "alice should have two receipts");
        assertEq(aliceReceipts[0].taskId, TASK_ID, "first task should be first");
        assertEq(aliceReceipts[1].taskId, TASK_ID_TWO, "second task should be second");
    }

    function testZeroTaskIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentTaskReceipt.InvalidTaskId.selector));
        receipt.recordReceipt(bytes32(0), REQUEST_HASH, RESULT_HASH);
    }

    function testNoOwnerFunctionExists() public view {
        (bool ok,) = address(receipt).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "owner function should not exist");
    }

    function testNoAdminTransferOwnershipFunctionExists() public {
        (bool ok,) = address(receipt).call(abi.encodeWithSignature("transferOwnership(address)", ALICE));
        assertFalse(ok, "admin ownership transfer should not exist");
    }

    function testDifferentTaskIdsCanShareRequestHash() public {
        receipt.recordReceipt(TASK_ID, REQUEST_HASH, RESULT_HASH);
        receipt.recordReceipt(TASK_ID_TWO, REQUEST_HASH, RESULT_HASH_TWO);

        assertEq(receipt.getReceiptCount(), 2, "unique task ids should both be accepted");
    }
}

