import { PrivateKey } from "o1js";

interface ContractConfig {
  contractPrivateKey: PrivateKey;
  contractAddress: string;
}

export const contract: ContractConfig = {
  contractPrivateKey: PrivateKey.fromBase58(
    "EKEWE9DtZs5LWe3cpqVCojWTjHTptBD5fKJKWtB94eBjN2uuYKmh"
  ),
  contractAddress: "B62qpXPvmKDf4SaFJynPsT6DyvuxMS9H1pT4TGonDT26m599m7dS9gP",
};

export const DEPLOYER = "EKFDvpBMGGa1bGrE9BhNLzr4VEBopt9ANfwTzE5Z3yqSBegiUUhk";
