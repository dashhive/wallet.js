#!/usr/bin/env node
"use strict";

//@ts-ignore
let pkg = require("../package.json");

/**
 * @typedef {import('../').Config} Config
 * @typedef {import('../').Safe} Safe
 * @typedef {import('../').Cache} Cache
 * @typedef {import('../').MiniUtxo} MiniUtxo
 * @typedef {import('../').PayWallet} PayWallet
 * @typedef {import('../').Preferences} Preferences
 * @typedef {import('../').PrivateWallet} PrivateWallet
 * @typedef {import('../').WalletAddress} WalletAddress
 * @typedef {import('../').WalletInstance} WalletInstance
 */

let Crypto = require("node:crypto");
let Os = require("node:os");
let home = Os.homedir();

require("dotenv").config({ path: `${home}/.config/dash/env` });
require("dotenv").config({ path: `${home}/.config/dash/.env.secret` });

let Path = require("node:path");
let Fs = require("node:fs/promises");

let Wallet = require("../wallet.js");

let b58c = require("../lib/dashcheck.js");
let Dashsight = require("dashsight");
let Secp256k1 = require("secp256k1");
// let Qr = require("./qr.js");

/**
 * @typedef FsStoreConfig
 * @prop {String} dir
 * @prop {String} cachePath
 * @prop {String} payWalletsPath
 * @prop {String} preferencesPath
 * @prop {String} privateWalletsPath
 */

/** @type {FsStoreConfig} */
let storeConfig = {
  dir: `${home}/.config/dash`,

  // paths
  cachePath: "",
  payWalletsPath: "",
  preferencesPath: "",
  privateWalletsPath: "",
};

/** @type {Config} */
//@ts-ignore
let config = {};

async function main() {
  let args = process.argv.slice(2);

  let confDir = removeFlagAndArg(args, ["-c", "--config-dir"]);
  if (confDir) {
    // TODO check validity
    storeConfig.dir = confDir;
  }

  config.dashsight = Dashsight.create({
    baseUrl: "", // TODO baseUrl is deprecated and should not be required
    insightBaseUrl:
      process.env.INSIGHT_BASE_URL || "https://insight.dash.org/insight-api",
    dashsightBaseUrl:
      process.env.DASHSIGHT_BASE_URL ||
      "https://dashsight.dashincubator.dev/insight-api",
    dashsocketBaseUrl:
      process.env.DASHSOCKET_BASE_URL || "https://insight.dash.org/socket.io",
  });

  storeConfig.cachePath = Path.join(storeConfig.dir, "cache.json");
  storeConfig.payWalletsPath = Path.join(storeConfig.dir, "pay-wallets.json");
  storeConfig.preferencesPath = Path.join(storeConfig.dir, "preferences.json");
  storeConfig.privateWalletsPath = Path.join(
    storeConfig.dir,
    "private-wallets.json",
  );
  config.store = Storage.create(storeConfig, config);
  // TODO
  //getWallets / getEachWallet
  //getWallets
  //getWallet
  //setWallet
  //getAddresses / getEachAddress
  //getAddress
  //setAddress

  config.safe = await config.store.init(storeConfig);

  let wallet = await Wallet.create(config);

  let version = removeFlag(args, ["version", "-V", "--version"]);
  if (version) {
    console.info(`dashwallet v${pkg.version}`);
    process.exit(0);
    return;
  }

  let friend = removeFlag(args, ["friend"]);
  if (friend) {
    await befriend(config, wallet, args);
    return wallet;
  }

  let importWif = removeFlag(args, ["import"]);
  if (importWif) {
    await createWif(config, wallet, args);
    return wallet;
  }

  let send = removeFlag(args, ["send", "pay"]);
  if (send) {
    await pay(config, wallet, args);
    return wallet;
  }

  let showBalances = removeFlag(args, ["balance", "balances"]);
  if (showBalances) {
    await getBalances(config, wallet, args);
    return wallet;
  }

  // TODO export, delete
  // TODO add note/comment to wallet, address, tx, etc

  let gen = removeFlag(args, ["create", "generate", "new"]);
  if (gen) {
    let genWif = removeFlag(args, ["wif", "address"]);
    if (!genWif) {
      console.error(`Unrecognized subcommand '${gen} ${args[0]}'`);
      process.exit(1);
    }
    await generateWif(config, wallet, args);
    return wallet;
  }

  let showStats = removeFlag(args, ["stat", "stats", "status"]);
  if (showStats) {
    await stat(config, wallet, args);
    return wallet;
  }

  let forceSync = removeFlag(args, ["reindex", "sync"]);
  if (forceSync) {
    let now = Date.now();
    console.info("syncing...");
    await wallet.sync({ now: now, staletime: 0 });
    return wallet;
  }

  if (!args[0]) {
    usage();
    let help = removeFlag(args, ["help", "--help", "-h"]);
    if (help) {
      process.exit(0);
      return;
    }
    process.exit(1);
    return;
  }
  throw new Error(`'${args[0]}' is not a recognized subcommand`);
}

function usage() {
  console.info();
  console.info(`Usage:`);
  console.info(`    wallet balances`);
  console.info(`    wallet friend <handle> [xpub-or-static-addr]`);
  console.info(`    wallet generate address`);
  console.info(`    wallet import <./path/to.wif>`);
  console.info(`    wallet pay <handle|pay-addr> <DASH> [--dry-run]`);
  console.info(`    wallet stat <addr>`);
  console.info(`    wallet sync`);
  console.info(`    wallet version`);
  console.info();
  console.info(`Global Options:`);
  // TODO --offline mode
  console.info(`    --config-dir ~/.config/dash/`);
  console.info();
}

/**
 * @param {Config} config
 * @param {WalletInstance} wallet
 * @param {Array<String>} args
 */
async function befriend(config, wallet, args) {
  let [handle, xpubOrAddr] = args;
  if (!handle) {
    throw Error(`Usage: wallet friend <handle> [xpub-or-static-addr]`);
  }

  let xpub = "";
  let addr = "";
  if (Wallet.isXPub(xpubOrAddr)) {
    xpub = xpubOrAddr;
  } else {
    addr = xpubOrAddr;
  }

  let [rxXPub, txWallet] = await wallet.befriend({
    handle,
    xpub,
    addr,
  });

  let txAddr = {
    addr: txWallet?.addr || "",
    index: 0,
  };
  if (txWallet?.xpub) {
    txAddr = await wallet.createNextPayAddr({ handle });
  }
  if (txAddr.addr) {
    let addrIndex = `#${txAddr.index}`;
    if (txWallet?.addr) {
      addrIndex = `multi-use`;
    }

    console.info();
    console.info(`Send DASH to '${handle}' at this address (${addrIndex}):`);
    // TODO QR
    console.info(`${txAddr.addr}`);
  }

  console.info();
  console.info(`Share this "dropbox" wallet (xpub) with '${handle}':`);
  // TODO QR and next addr
  console.info(rxXPub);
}

/**
 * @param {Config} config
 * @param {WalletInstance} wallet
 * @param {Array<String>} args
 */
async function createWif(config, wallet, args) {
  let wifPaths = args;
  if (!wifPaths.length) {
    throw Error(`Usage: wallet import <./path/1.wif> [./path/2.wif, ...]`);
  }

  /** @type {Array<String>} */
  let wifs = [];
  await wifPaths.reduce(async function (promise, wifPath) {
    await promise;

    let wif = await Fs.readFile(wifPath, "utf8");
    // TODO check wif-y-ness
    wifs.push(wif.trim());
  }, Promise.resolve());

  let addrInfos = await wallet.import({
    wifs,
  });

  console.info();
  console.info(`Imported the following into the standalone 'wifs' wallet:`);
  addrInfos.forEach(
    /** @param {WalletAddress} addrInfo */
    function (addrInfo) {
      let totalBalance = Wallet.getBalance(addrInfo.utxos);
      let dashBalance = Wallet.toDash(totalBalance);
      console.info(`    ${addrInfo.addr} (${dashBalance})`);
    },
  );
}

/**
 * @param {Config} config
 * @param {WalletInstance} wallet
 * @param {Array<String>} args
 */
async function generateWif(config, wallet, args) {
  let privKey;
  for (;;) {
    // TODO browser
    privKey = Crypto.randomBytes(32);
    if (Secp256k1.privateKeyVerify(privKey)) {
      break;
    }
  }

  let wif = await b58c.encode({
    version: Wallet.DashTypes.privateKeyVersion,
    pubKeyHash: privKey.toString("hex"),
    compressed: true,
  });

  // TODO --no-import
  // TODO --offline (we don't need to check txs on what we just generated)
  let addrInfos = await wallet.import({ wifs: [wif] });
  let addrInfo = addrInfos[0];

  console.info();
  console.info(`Generated (and imported) the following private key (wif):`);
  console.info();
  console.info(`    ${addrInfo.addr}`);
  console.info();
}

/**
 * @param {Config} config
 * @param {WalletInstance} wallet
 * @param {Array<String>} args
 */
async function pay(config, wallet, args) {
  let dryRun = removeFlag(args, ["--dry-run"]);

  let [handle, DASH] = args;
  if (!handle) {
    throw Error(
      `Usage: wallet pay <handle-or-addr> <DASH>\nExample: wallet send @joey 1.0`,
    );
  }

  let hasDecimal = DASH?.split(".").length;
  let satoshis = Wallet.toDuff(parseFloat(DASH));
  if (!hasDecimal || !satoshis) {
    throw Error(
      `DASH amount must be given in decimal form, such as 1.0 or 0.00100000`,
    );
  }

  let txHex = await wallet.createTx({ handle, amount: satoshis });

  if (dryRun) {
    console.info();
    console.info(
      "Transaction Hex: (inspect at https://live.blockcypher.com/dash/decodetx/)",
    );
    console.info(txHex);
    console.info();
    return;
  }

  let txResult = await config.dashsight.instantSend(txHex);
  console.info();
  console.info("Sent!");
  console.info();
  console.info(`https://insight.dash.org/tx/${txResult.body.txid}`);
  console.info();
}

/**
 * @param {Config} config
 * @param {WalletInstance} wallet
 * @param {Array<String>} args
 */
async function getBalances(config, wallet, args) {
  let balance = 0;

  console.info("syncing...");
  let now = Date.now();
  await wallet.sync({ now });

  console.info();
  console.info("Wallets:");
  console.info();

  let balances = await wallet.balances();
  Object.entries(balances).forEach(function ([wallet, satoshis]) {
    balance += satoshis;
    let floatBalance = parseFloat((satoshis / Wallet.DUFFS).toFixed(8));
    console.info(`    ${wallet}: ${floatBalance}`);
  });

  console.info();
  let floatBalance = parseFloat((balance / Wallet.DUFFS).toFixed(8));
  console.info(`Total: ${floatBalance}`);
}

/**
 * @param {Config} config
 * @param {WalletInstance} wallet
 * @param {Array<String>} args
 */
async function stat(config, wallet, args) {
  let [addrPrefix] = args;
  if (!addrPrefix) {
    throw Error(`Usage: wallet stat <addr-like>`);
  }

  let addrInfos = await wallet.findAddrs(addrPrefix);
  if (!addrInfos.length) {
    console.error();
    console.error(`'${addrPrefix}' did not matches any address in any wallets`);
    console.error();
    process.exit(1);
  }

  if (addrInfos.length > 1) {
    console.error();
    console.error(`'${addrPrefix}' matches the following addresses:`);
    console.error();
    addrInfos.forEach(
      /** @param {Required<WalletAddress>} addrInfo */
      function (addrInfo) {
        console.error(`    ${addrInfo.addr}`);
      },
    );
    console.error();
    process.exit(1);
  }

  let addrs = addrInfos.map(
    /** @param {Required<WalletAddress>} addrInfo */
    function (addrInfo) {
      return addrInfo.addr;
    },
  );
  addrInfos = await wallet.stat({ addrs: addrs });

  addrInfos.forEach(
    /** @param {WalletAddress} addrInfo */
    function (addrInfo) {
      // TODO timestamp
      let totalBalance = Wallet.getBalance(addrInfo.utxos);
      let dashBalance = Wallet.toDash(totalBalance).toFixed(8);
      console.info(
        `${addrInfo.addr} (${dashBalance}) - ${addrInfo.wallet}:${addrInfo.hdpath}/${addrInfo.index}`,
      );
      if (addrInfo.utxos.length > 1) {
        addrInfo.utxos.forEach(
          /** @param {MiniUtxo} utxo */
          function (utxo) {
            console.info(`    ${utxo.satoshis}`);
          },
        );
      }
    },
  );
}

/**
 * @param {Array<String>} arr
 * @param {Array<String>} aliases
 * @returns {String?}
 */
function removeFlag(arr, aliases) {
  /** @type {String?} */
  let arg = null;
  aliases.forEach(function (item) {
    let index = arr.indexOf(item);
    if (-1 === index) {
      return null;
    }

    if (arg) {
      throw Error(`duplicate flag ${item}`);
    }

    arg = arr.splice(index, 1)[0];
  });

  return arg;
}

let Storage = {}; //jshint ignore:line

/**
 * @param {FsStoreConfig} storeConfig
 * @param {Config} config
 */
Storage.create = function (storeConfig, config) {
  /**
   * Fetches all the config and wallet data
   * @returns {Promise<Safe>}
   */
  async function init() {
    let cache = await _init(storeConfig.cachePath);
    let payWallets = await _init(storeConfig.payWalletsPath);
    let preferences = await _init(storeConfig.preferencesPath);
    let privateWallets = await _init(storeConfig.privateWalletsPath);

    return {
      cache,
      payWallets,
      preferences,
      privateWallets,
    };
  }

  /**
   * Fetches all data from the file
   * @param {String} path
   */
  async function _init(path) {
    await Fs.mkdir(storeConfig.dir, { recursive: true });

    let fh = await Fs.open(path, "a");
    await fh.close();

    let text = await Fs.readFile(path, "utf8");
    let data = JSON.parse(text || "{}");
    /*
    data._path = function () {
      return path;
    };
    */
    // TODO find a better way to do this
    Object.defineProperty(data, "_path", {
      enumerable: false,
      value: function () {
        return path;
      },
    });

    return data;
  }

  /**
   * @typedef {Object<String, PayWallet>} DPayWallets
   * @typedef {Object<String, PrivateWallet>} DPrivateWallets
   */

  /**
   * Safely save the safe
   * TODO - encrypt private wallets
   * @param {Cache|DPayWallets|DPrivateWallets|Preferences} data
   * @returns {Promise<void>}
   */
  async function save(data) {
    if ("function" !== typeof data?._path) {
      let t = typeof data;
      let keys = Object.keys(data || {});
      throw new Error(
        `[Sanity Fail] no '_path' on 'data' (${t}: ${keys}) (probably a developer error)`,
      );
    }
    let path = data._path();
    await safeReplace(path, JSON.stringify(data, null, 2), "utf8");
  }

  return {
    init,
    save,
  };
};

/**
 * Safely replacing a file by renaming the original as a .bak before replacement
 * @param {String} filepath
 * @param {String|ArrayBuffer} contents
 * @param {String?} enc
 */
async function safeReplace(filepath, contents, enc = null) {
  await Fs.writeFile(`${filepath}.tmp`, contents, enc);
  await Fs.unlink(`${filepath}.bak`).catch(Object);
  await Fs.rename(`${filepath}`, `${filepath}.bak`);
  await Fs.rename(`${filepath}.tmp`, `${filepath}`);
}

/**
 * @param {Array<String>} arr
 * @param {Array<String>} aliases
 * @returns {String?}
 */
function removeFlagAndArg(arr, aliases) {
  /** @type {String?} */
  let arg = null;
  aliases.forEach(function (item) {
    let index = arr.indexOf(item);
    if (-1 === index) {
      return null;
    }

    // flag
    let flag = arr.splice(index, 1);

    if (arg) {
      throw Error(`duplicate flag ${item}`);
    }

    // flag's arg
    arg = arr.splice(index, 1)[0];
    if ("undefined" === typeof arg) {
      throw Error(`'${flag}' requires an argument`);
    }
  });

  return arg;
}

main()
  .then(async function (wallet) {
    if (wallet) {
      console.info();
      console.info("reindexing...");
      let now = Date.now();
      await wallet.sync({ now: now });
      console.info();
    }
    process.exit(0);
  })
  .catch(function (err) {
    console.error("Fail:");
    console.error(err.stack || err);
    if (err.failedTx) {
      console.error(
        "Failed Transaciton: (inspect at https://live.blockcypher.com/dash/decodetx/)",
      );
      console.error(err.failedTx);
    }
    if (err.response) {
      console.error(err.response);
    }
    process.exit(1);
  });
