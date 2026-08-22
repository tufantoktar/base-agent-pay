// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {AgentTaskReceipt} from "../src/AgentTaskReceipt.sol";

contract DeployAgentTaskReceipt is Script {
    function run() external returns (AgentTaskReceipt) {
        vm.startBroadcast();
        AgentTaskReceipt receipt = new AgentTaskReceipt();
        vm.stopBroadcast();

        return receipt;
    }
}
