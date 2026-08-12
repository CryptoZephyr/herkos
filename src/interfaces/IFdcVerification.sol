// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// XRPPayment proof shape taken from the *verified implementation* behind the
/// FdcVerification ERC-1967 proxy — impl 0xf7f0057b4c6564f56479fdbb2e934c78ec4e094b,
/// proxy 0x5c14fe9d73ab763f4d4a76f334bf7029ddd20ecc. The documented interfaces
/// differ; guessing selectors from the docs makes deployed functions look absent.
///
/// XRPPayment is preferred over the generic Payment because responseBody carries
/// `sourceAddress` as a plain string. The Core Vault's XRPL account is also a
/// string (CoreVaultManager.coreVaultAddress()), so subject binding is a direct
/// comparison with no hash convention to guess wrong.
///
/// FAssets itself consumes this exact struct via
/// AssetManager.confirmXRPRedemptionPayment(IXRPPayment.Proof, uint256).
library IXRPPayment {
    struct RequestBody {
        bytes32 transactionId;
        address proofOwner;
    }

    struct ResponseBody {
        uint64 blockNumber;
        uint64 blockTimestamp;
        string sourceAddress;
        bytes32 sourceAddressHash;
        bytes32 receivingAddressHash;
        bytes32 intendedReceivingAddressHash;
        int256 spentAmount;
        int256 intendedSpentAmount;
        int256 receivedAmount;
        int256 intendedReceivedAmount;
        bool hasMemoData;
        bytes firstMemoData;
        bool hasDestinationTag;
        uint256 destinationTag;
        uint8 status;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}

interface IFdcVerification {
    function verifyXRPPayment(IXRPPayment.Proof calldata _proof) external view returns (bool);

    function fdcProtocolId() external view returns (uint8);
}
