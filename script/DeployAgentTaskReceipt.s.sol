// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AgentTaskReceipt} from "../src/AgentTaskReceipt.sol";

contract DeployAgentTaskReceipt {
    function run() external returns (AgentTaskReceipt) {
        return new AgentTaskReceipt();
    }
}

