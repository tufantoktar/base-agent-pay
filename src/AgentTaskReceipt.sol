// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentTaskReceipt
/// @notice Immutable, permissionless registry for completed paid agent task receipts.
/// @dev This contract never receives or moves funds and has no admin path.
contract AgentTaskReceipt {
    error DuplicateTaskId(bytes32 taskId);
    error InvalidTaskId();
    error UnknownTaskId(bytes32 taskId);

    struct Receipt {
        address requester;
        bytes32 taskId;
        bytes32 requestHash;
        bytes32 resultHash;
        uint256 timestamp;
    }

    event AgentTaskReceiptRecorded(
        bytes32 indexed taskId, address indexed requester, bytes32 requestHash, bytes32 resultHash, uint256 timestamp
    );

    mapping(bytes32 taskId => Receipt receipt) private receipts;
    mapping(bytes32 taskId => bool exists) private receiptExists;
    mapping(address requester => bytes32[] taskIds) private receiptsByRequester;
    bytes32[] private receiptIds;

    function recordReceipt(bytes32 taskId, bytes32 requestHash, bytes32 resultHash) external {
        if (taskId == bytes32(0)) {
            revert InvalidTaskId();
        }
        if (receiptExists[taskId]) {
            revert DuplicateTaskId(taskId);
        }

        uint256 recordedAt = block.timestamp;
        Receipt memory receipt = Receipt({
            requester: msg.sender,
            taskId: taskId,
            requestHash: requestHash,
            resultHash: resultHash,
            timestamp: recordedAt
        });

        receipts[taskId] = receipt;
        receiptExists[taskId] = true;
        receiptIds.push(taskId);
        receiptsByRequester[msg.sender].push(taskId);

        emit AgentTaskReceiptRecorded(taskId, msg.sender, requestHash, resultHash, recordedAt);
    }

    function getReceipt(bytes32 taskId) external view returns (Receipt memory) {
        if (!receiptExists[taskId]) {
            revert UnknownTaskId(taskId);
        }

        return receipts[taskId];
    }

    function hasReceipt(bytes32 taskId) external view returns (bool) {
        return receiptExists[taskId];
    }

    function getReceiptCount() external view returns (uint256) {
        return receiptIds.length;
    }

    function getReceiptsByRequester(address requester) external view returns (Receipt[] memory) {
        bytes32[] storage taskIds = receiptsByRequester[requester];
        Receipt[] memory requesterReceipts = new Receipt[](taskIds.length);

        for (uint256 i = 0; i < taskIds.length; i++) {
            requesterReceipts[i] = receipts[taskIds[i]];
        }

        return requesterReceipts;
    }
}

