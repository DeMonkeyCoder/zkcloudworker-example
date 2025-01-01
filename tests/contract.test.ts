import { describe, expect, it } from "@jest/globals";
import {
  PrivateKey,
  Mina,
  AccountUpdate,
  VerificationKey,
  UInt64,
  Cache,
  PublicKey,
  setNumberOfWorkers,
} from "o1js";

import {
  zkCloudWorkerClient,
  blockchain,
  sleep,
  Memory,
  fetchMinaAccount,
  fee,
  initBlockchain,
  serializeFields,
  accountBalanceMina,
} from "zkcloudworker";
import { zkcloudworker } from "..";
import { AddContract } from "../src/contract";
import { contract, DEPLOYER } from "./config";
import packageJson from "../package.json";
import { JWT } from "../env.json";

const ONE_ELEMENTS_NUMBER = 1;
const MANY_ELEMENTS_NUMBER = 1;
const MANY_BATCH_SIZE = 3;
setNumberOfWorkers(8);

const { name: repo, author: developer } = packageJson;
const {
  chain,
  compile,
  deploy,
  one,
  many,
  send,
  files,
  encrypt,
  useLocalCloudWorker,
} = processArguments();

const api = new zkCloudWorkerClient({
  jwt: useLocalCloudWorker ? "local" : JWT,
  zkcloudworker,
  chain,
});

let deployer: PrivateKey;
let sender: PublicKey;


const contractPrivateKey = contract.contractPrivateKey;
const contractPublicKey = deploy ? contractPrivateKey.toPublicKey() : PublicKey.fromBase58(contract.contractAddress);

const zkApp = new AddContract(contractPublicKey);
let contractVerificationKey: VerificationKey;
let blockchainInitialized = false;

describe("Add Worker", () => {

  it(`should initialize blockchain`, async () => {
    if(deploy) {
      expect(contractPrivateKey).toBeDefined();
      expect(contractPrivateKey.toPublicKey().toBase58()).toBe(
          contractPublicKey.toBase58()
      );
    }

    Memory.info("initializing blockchain");

    if (chain === "local" || chain === "lightnet") {
      console.log("local chain:", chain);
      const { keys } = await initBlockchain(chain, 2);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      if (keys.length < 2) throw new Error("Invalid keys");
      deployer = keys[0].key;
    } else {
      console.log("non-local chain:", chain);
      await initBlockchain(chain);
      deployer = PrivateKey.fromBase58(DEPLOYER);
    }

    process.env.DEPLOYER_PRIVATE_KEY = deployer.toBase58();
    process.env.DEPLOYER_PUBLIC_KEY = deployer.toPublicKey().toBase58();

    console.log("contract address:", contractPublicKey.toBase58());
    sender = deployer.toPublicKey();
    console.log("sender:", sender.toBase58());
    console.log("Sender balance:", await accountBalanceMina(sender));
    expect(deployer).toBeDefined();
    expect(sender).toBeDefined();
    expect(deployer.toPublicKey().toBase58()).toBe(sender.toBase58());
    Memory.info("blockchain initialized");
    blockchainInitialized = true;
  });

  if (compile) {
    it(`should compile contract`, async () => {
      expect(blockchainInitialized).toBe(true);
      console.log("Analyzing contracts methods...");
      console.time("methods analyzed");
      const methods = [
        { name: "AddContract", result: await AddContract.analyzeMethods(), skip: false },
      ];
      console.timeEnd("methods analyzed");
      const maxRows = 2 ** 16;
      for (const contract of methods) {
        // calculate the size of the contract - the sum or rows for each method
        const size = Object.values(contract.result).reduce(
          (acc, method) => acc + method.rows,
          0
        );
        // calculate percentage rounded to 0 decimal places
        const percentage = Math.round(((size * 100) / maxRows) * 100) / 100;

        console.log(
          `method's total size for a ${contract.name} is ${size} rows (${percentage}% of max ${maxRows} rows)`
        );
        if (contract.skip !== true)
          for (const method in contract.result) {
            console.log(method, `rows:`, (contract.result as any)[method].rows);
          }
      }

      console.time("compiled");
      console.log("Compiling contracts...");
      const cache: Cache = Cache.FileSystem("./cache");

      console.time("AddContract compiled");
      contractVerificationKey = (await AddContract.compile({ cache }))
        .verificationKey;
      console.timeEnd("AddContract compiled");
      console.timeEnd("compiled");
      console.log(
        "AddContract verification key",
        contractVerificationKey.hash.toJSON()
      );
      Memory.info("compiled");
    });
  }
  if (deploy) {
    it(`should deploy contract`, async () => {
      expect(blockchainInitialized).toBe(true);
      console.log("Fetching sender account...");

      await fetchMinaAccount({ publicKey: sender, force: true });
      console.log(`Deploying contract...`);

      const tx = await Mina.transaction(
        { sender, fee: await fee(), memo: "deploy" },
        async () => {
          AccountUpdate.fundNewAccount(sender);
          await zkApp.deploy({});
          zkApp.account.zkappUri.set("https://zkcloudworker.com");
        }
      );

      tx.sign([deployer, contractPrivateKey]);
      await sendTx(tx, "deploy");
      Memory.info("deployed");
    });
  }

  if (send) {
    it(`should send first one tx`, async () => {
      expect(blockchainInitialized).toBe(true);
      console.log(`Sending first one tx...`);

      await fetchMinaAccount({ publicKey: sender, force: true });
      await fetchMinaAccount({ publicKey: contractPublicKey, force: true });
      const privateKey = PrivateKey.random();

      const tx = await Mina.transaction(
        { sender, fee: await fee(), memo: "one tx" },
        async () => {
          AccountUpdate.fundNewAccount(sender);
          await zkApp.update();
        }
      );

      await tx.prove();
      tx.sign([deployer, privateKey]);
      await sendTx(tx, "first one tx");
      Memory.info("first one tx sent");
      await sleep(10000);
    });
  }

  if (one) {
    it(`should send one transactions`, async () => {
      expect(blockchainInitialized).toBe(true);
      console.time(`One txs sent`);
      for (let i = 0; i < ONE_ELEMENTS_NUMBER; i++) {
        console.log(`Sending one tx ${i + 1}/${ONE_ELEMENTS_NUMBER}...`);
        const answer = await api.execute({
          developer,
          repo,
          transactions: [],
          task: "update",
          args: JSON.stringify({
            contractAddress: contractPublicKey.toBase58(),
            isMany: false,
          }),
          metadata: `update`,
        });
        console.log("answer:", answer);
        expect(answer).toBeDefined();
        expect(answer.success).toBe(true);
        const jobId = answer.jobId;
        expect(jobId).toBeDefined();
        if (jobId === undefined) throw new Error("Job ID is undefined");
        const oneResult = await api.waitForJobResult({
          jobId,
          printLogs: true,
        });
        console.log("One result:", oneResult.result.result);
      }
      console.timeEnd(`One txs sent`);
      Memory.info(`One txs sent`);
    });
  }

  if (files) {
    it(`should save and get files`, async () => {
      expect(blockchainInitialized).toBe(true);
      const answer = await api.execute({
        developer,
        repo,
        transactions: [],
        task: "files",
        args: JSON.stringify({
          contractAddress: contractPublicKey.toBase58(),
          text: "Hello, World!",
        }),
        metadata: `files`,
      });
      console.log("answer:", answer);
      expect(answer).toBeDefined();
      expect(answer.success).toBe(true);
      const jobId = answer.jobId;
      expect(jobId).toBeDefined();
      if (jobId === undefined) throw new Error("Job ID is undefined");
      const filesResult = await api.waitForJobResult({
        jobId,
        printLogs: true,
      });
      console.log("Files test result:", filesResult.result.result);
    });
  }

  if (encrypt) {
    it(`should save and get encrypted data`, async () => {
      let answer = await api.execute({
        developer,
        repo,
        transactions: [],
        task: "encrypt",
        args: JSON.stringify({
          contractAddress: contractPublicKey.toBase58(),
          text: "Hello, World!",
        }),
        metadata: `files`,
      });
      console.log("answer:", answer);
      expect(answer).toBeDefined();
      expect(answer.success).toBe(true);
      let jobId = answer.jobId;
      expect(jobId).toBeDefined();
      if (jobId === undefined) throw new Error("Job ID is undefined");
      let result = await api.waitForJobResult({
        jobId,
        printLogs: true,
      });
      const encrypted = result.result.result;
      console.log("Encrypted data:", encrypted);
      if (encrypted === undefined)
        throw new Error("Encrypted data is undefined");
      if (encrypted === "Error encrypting") throw new Error("Error encrypting");
      answer = await api.execute({
        developer,
        repo,
        transactions: [],
        task: "decrypt",
        args: JSON.stringify({
          contractAddress: contractPublicKey.toBase58(),
          text: encrypted,
        }),
        metadata: `files`,
      });
      console.log("answer:", answer);
      expect(answer).toBeDefined();
      expect(answer.success).toBe(true);
      jobId = answer.jobId;
      expect(jobId).toBeDefined();
      if (jobId === undefined) throw new Error("Job ID is undefined");
      result = await api.waitForJobResult({
        jobId,
        printLogs: true,
      });
      const decrypted = result.result.result;
      console.log("Decrypted data:", decrypted);
      expect(decrypted).toBe("Hello, World!");
    });
  }
});

function processArguments(): {
  chain: blockchain;
  compile: boolean;
  deploy: boolean;
  one: boolean;
  many: boolean;
  send: boolean;
  files: boolean;
  encrypt: boolean;
  useLocalCloudWorker: boolean;
} {
  function getArgument(arg: string): string | undefined {
    const argument = process.argv.find((a) => a.startsWith("--" + arg));
    return argument?.split("=")[1];
  }

  const chainName = getArgument("chain") ?? "local";
  const shouldDeploy = getArgument("deploy") ?? "true";
  const compile = getArgument("compile");
  const one = getArgument("one") ?? "true";
  const many = getArgument("many") ?? "true";
  const send = getArgument("send") ?? "false";
  const files = getArgument("files") ?? "false";
  const encrypt = getArgument("encrypt") ?? "false";
  const cloud = getArgument("cloud");

  if (
    chainName !== "local" &&
    chainName !== "devnet" &&
    chainName !== "lightnet" &&
    chainName !== "zeko"
  )
    throw new Error("Invalid chain name");
  return {
    chain: chainName as blockchain,
    compile: compile === "true" || shouldDeploy === "true" || send === "true",
    deploy: shouldDeploy === "true",
    one: one === "true",
    many: many === "true",
    send: send === "true",
    files: files === "true",
    encrypt: encrypt === "true",
    useLocalCloudWorker: cloud
      ? cloud === "local"
      : chainName === "local" || chainName === "lightnet",
  };
}

async function sendTx(
  tx: Mina.Transaction<false, true> | Mina.Transaction<true, true>,
  description?: string
) {
  try {
    let txSent;
    let sent = false;
    while (!sent) {
      txSent = await tx.safeSend();
      if (txSent.status === "pending") {
        sent = true;
        console.log(
          `${description ?? ""} tx sent: hash: ${txSent.hash} status: ${
            txSent.status
          }`
        );
      } else if (chain === "zeko") {
        console.log("Retrying Zeko tx");
        await sleep(10000);
      } else {
        console.log(
          `${description ?? ""} tx NOT sent: hash: ${txSent?.hash} status: ${
            txSent?.status
          }`
        );
        return "Error sending transaction";
      }
    }
    if (txSent === undefined) throw new Error("txSent is undefined");
    if (txSent.errors.length > 0) {
      console.error(
        `${description ?? ""} tx error: hash: ${txSent.hash} status: ${
          txSent.status
        }  errors: ${txSent.errors}`
      );
    }

    if (txSent.status === "pending") {
      console.log(`Waiting for tx inclusion...`);
      const txIncluded = await txSent.safeWait();
      console.log(
        `${description ?? ""} tx included into block: hash: ${
          txIncluded.hash
        } status: ${txIncluded.status}`
      );
    }
  } catch (error) {
    if (chain !== "zeko") console.error("Error sending tx", error);
  }
  if (chain !== "local") await sleep(10000);
}
