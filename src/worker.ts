import {
  zkCloudWorker,
  Cloud,
  fee,
  sleep,
  deserializeFields,
  fetchMinaAccount,
  accountBalanceMina,
} from "zkcloudworker";
import {
  verify,
  JsonProof,
  VerificationKey,
  PublicKey,
  Mina,
  PrivateKey,
  AccountUpdate,
  Cache,
} from "o1js";
import { AddContract } from "./contract";

export class AddWorker extends zkCloudWorker {
  static contractVerificationKey: VerificationKey | undefined = undefined;
  readonly cache: Cache;

  constructor(cloud: Cloud) {
    super(cloud);
    this.cache = Cache.FileSystem(this.cloud.cache);
  }

  private async compile(compileSmartContracts: boolean = true): Promise<void> {
    try {
      console.time("compiled");
      if (compileSmartContracts === false) {
        console.timeEnd("compiled");
        return;
      }

      if (AddWorker.contractVerificationKey === undefined) {
        console.time("compiled AddContract");
        AddWorker.contractVerificationKey = (
          await AddContract.compile({
            cache: this.cache,
          })
        ).verificationKey;
        console.timeEnd("compiled AddContract");
      }
      console.timeEnd("compiled");
    } catch (error) {
      console.error("Error in compile, restarting container", error);
      // Restarting the container, see https://github.com/o1-labs/o1js/issues/1651
      await this.cloud.forceWorkerRestart();
      throw error;
    }
  }


  public async execute(transactions: string[]): Promise<string | undefined> {
    if (this.cloud.args === undefined)
      throw new Error("this.cloud.args is undefined");
    const args = JSON.parse(this.cloud.args);
    //console.log("args", args);
    if (args.contractAddress === undefined)
      throw new Error("args.contractAddress is undefined");

    switch (this.cloud.task) {
      case "update":
        return await this.sendTx({ ...args, isMany: false });

      case "files":
        return await this.files(args);

      case "encrypt":
        return await this.encrypt(args);

      case "decrypt":
        return await this.decrypt(args);

      default:
        throw new Error(`Unknown task: ${this.cloud.task}`);
    }
  }

  private async files(args: { text: string }): Promise<string> {
    console.log("files test", args);
    if (args.text === undefined) throw new Error("args.text is undefined");
    const str = args.text;
    const buf = Buffer.from(str);
    await this.cloud.saveFile("text.txt", buf);
    const buf2 = await this.cloud.loadFile("text.txt");
    if (buf2 === undefined) return "Error loading file";
    const str2 = buf2.toString();
    if (str === str2) return "Files test is passed";
    else {
      console.log("Files are different", { str2, buf2 });
      return "Files are different";
    }
  }

  private async encrypt(args: {
    contractAddress: string;
    text: string;
  }): Promise<string> {
    console.log("encrypt", args);
    const { text, contractAddress } = args;
    if (text === undefined) throw new Error("args.text is undefined");
    if (contractAddress === undefined)
      throw new Error("args.contractAddress is undefined");
    return (
      (await this.cloud.encrypt({ data: text, context: contractAddress })) ??
      "Error encrypting"
    );
  }

  private async decrypt(args: {
    contractAddress: string;
    text: string;
  }): Promise<string> {
    console.log("decrypt", args);
    const { text, contractAddress } = args;
    if (text === undefined) throw new Error("args.text is undefined");
    if (contractAddress === undefined)
      throw new Error("args.contractAddress is undefined");
    return (
      (await this.cloud.decrypt({ data: text, context: contractAddress })) ??
      "Error decrypting"
    );
  }

  private async sendTx(args: {
    proof?: string;
    isMany: boolean;
    contractAddress: string;
  }): Promise<string> {
    if (args.isMany === undefined) throw new Error("args.isMany is undefined");
    const isMany = args.isMany as boolean;
    console.log("isMany:", isMany);
    if (isMany) {
      if (args.proof === undefined) throw new Error("args.proof is undefined");
    }

    const contractAddress = PublicKey.fromBase58(args.contractAddress);
    const zkApp = new AddContract(contractAddress);

    console.log(`Sending tx...`);
    console.time("prepared tx");
    const memo = "update";

    const deployerKeyPair = await this.cloud.getDeployer();
    if (deployerKeyPair === undefined)
      throw new Error("deployerKeyPair is undefined");
    const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
    console.log("cloud deployer:", deployer.toPublicKey().toBase58());
    if (deployer === undefined) throw new Error("deployer is undefined");
    const sender = deployer.toPublicKey();

    await fetchMinaAccount({
      publicKey: contractAddress,
      force: true,
    });
    await fetchMinaAccount({
      publicKey: sender,
      force: true,
    });

    console.log("sender:", sender.toBase58());
    console.log("Sender balance:", await accountBalanceMina(sender));
    await this.compile();

    let tx;
    let value: string;
    let limit: string;
    tx = await Mina.transaction(
        { sender, fee: await fee(), memo },
        async () => {
          await zkApp.update();
        }
    );
    if (tx === undefined) throw new Error("tx is undefined");
    await tx.prove();

    tx.sign([deployer]);

    try {
      await tx.prove();
      console.timeEnd("prepared tx");
      let txSent;
      let sent = false;
      while (!sent) {
        txSent = await tx.safeSend();
        if (txSent.status == "pending") {
          sent = true;
          console.log(
            `${memo} tx sent: hash: ${txSent.hash} status: ${txSent.status}`
          );
        } else if (this.cloud.chain === "zeko") {
          console.log("Retrying Zeko tx");
          await sleep(10000);
        } else {
          console.log(
            `${memo} tx NOT sent: hash: ${txSent?.hash} status: ${
              txSent?.status
            } errors: ${txSent.errors.join(", ")}`
          );
          return "Error sending transaction";
        }
      }
      if (this.cloud.isLocalCloud && txSent?.status === "pending") {
        const txIncluded = await txSent.safeWait();
        console.log(
          `one tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
        );
        await this.cloud.releaseDeployer({
          publicKey: deployerKeyPair.publicKey,
          txsHashes: [txIncluded.hash],
        });
        return txIncluded.hash;
      }
      await this.cloud.releaseDeployer({
        publicKey: deployerKeyPair.publicKey,
        txsHashes: txSent?.hash ? [txSent.hash] : [],
      });
      if (txSent?.hash)
        this.cloud.publishTransactionMetadata({
          txId: txSent?.hash,
          metadata: {
            method: "update"
          } as any,
        });
      return txSent?.hash ?? "Error sending transaction";
    } catch (error) {
      console.error("Error sending transaction", error);
      return "Error sending transaction";
    }
  }
}
